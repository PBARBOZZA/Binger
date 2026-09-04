import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { api } from './api';
import type { City } from './App';

type AuthMode = 'login' | 'register' | 'verify' | 'resend' | 'profile';

export function Auth() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState('');
  const [verificationEmail, setVerificationEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [cities, setCities] = useState<City[]>([]);
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api<City[]>('/cities').then(setCities);
  }, []);

  function changeMode(nextMode: AuthMode) {
    setError('');
    setNotice('');
    setMode(nextMode);
  }

  async function requestVerification(email: string) {
    setError('');
    setNotice('');
    setResending(true);
    try {
      const result = await api<{ message: string }>('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      setNotice(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Erro inesperado.');
    } finally {
      setResending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget);

    try {
      if (mode === 'register') {
        const email = String(form.get('email') ?? '');
        const result = await api<{ developmentToken?: string; message: string }>('/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email,
            password: form.get('password'),
            birthDate: form.get('birthDate'),
            adultDeclaration: form.get('adult') === 'on',
            acceptTerms: form.get('terms') === 'on',
            acceptPrivacy: form.get('privacy') === 'on'
          })
        });
        setVerificationEmail(email);
        setNotice(result.message);
        setToken(result.developmentToken ?? '');
        setMode('verify');
      } else if (mode === 'verify') {
        await api('/auth/verify-email', {
          method: 'POST',
          body: JSON.stringify({ token: form.get('token') })
        });
        setNotice('Conta confirmada. Agora entre.');
        setMode('login');
      } else if (mode === 'resend') {
        const email = String(form.get('email') ?? '');
        setVerificationEmail(email);
        await requestVerification(email);
      } else if (mode === 'login') {
        const result = await api<{ user: { profileComplete: boolean } }>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
        });
        if (result.user.profileComplete) {
          const me = await api<{ profile: { cityId: string } }>('/auth/me');
          const city = cities.find(candidate => candidate.id === me.profile.cityId);
          nav(`/sala/${city?.rooms[0]?.id}`);
        } else {
          setMode('profile');
        }
      } else {
        const cityId = String(form.get('cityId'));
        await api('/auth/profile', {
          method: 'PUT',
          body: JSON.stringify({ cityId, nickname: form.get('nickname'), interests: [] })
        });
        const city = cities.find(candidate => candidate.id === cityId);
        nav(`/sala/${city?.rooms[0]?.id}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Erro inesperado.');
    }
  }

  const step = mode === 'login'
    ? 'Bem-vindo de volta'
    : mode === 'register'
      ? 'Crie sua conta'
      : mode === 'verify'
        ? 'Confirme seu e-mail'
        : mode === 'resend'
          ? 'Confirmação de e-mail'
          : 'Escolha seu apelido';
  const title = mode === 'login'
    ? 'Entre para conversar'
    : mode === 'register'
      ? 'Comece com segurança'
      : mode === 'verify'
        ? 'Falta só uma etapa'
        : mode === 'resend'
          ? 'Receba um novo código'
          : 'Como você quer aparecer?';

  return <main className="auth-page">
    <section className="auth-side">
      <Link to="/"><ArrowLeft/> Voltar</Link>
      <div>
        <div className="brand">binger<span>.</span></div>
        <h1>Uma conversa local,<br/><em>sem exposição.</em></h1>
        <p>Seu nome verdadeiro e sua localização exata nunca são mostrados.</p>
      </div>
      <small><ShieldCheck/> Conexão e conta protegidas</small>
    </section>
    <section className="auth-card">
      <div className="step">{step}</div>
      <h2>{title}</h2>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <form onSubmit={submit}>
        {(mode === 'login' || mode === 'register') && <>
          <label>E-mail<input name="email" type="email" required autoComplete="email"/></label>
          <label>Senha<input name="password" type="password" required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'register' ? 'new-password' : 'current-password'}/></label>
        </>}
        {mode === 'register' && <>
          <label>Data de nascimento<input name="birthDate" type="date" required/></label>
          <label className="check"><input name="adult" type="checkbox" required/> Declaro ter 18 anos ou mais.</label>
          <label className="check"><input name="terms" type="checkbox" required/> Aceito os Termos de Uso.</label>
          <label className="check"><input name="privacy" type="checkbox" required/> Aceito a Política de Privacidade.</label>
          <p className="hint">Informações falsas podem resultar em suspensão da conta.</p>
        </>}
        {mode === 'verify' && <label>Código de confirmação<input name="token" required defaultValue={token}/></label>}
        {mode === 'resend' && <label>E-mail<input name="email" type="email" required autoComplete="email" defaultValue={verificationEmail}/></label>}
        {mode === 'profile' && <>
          <label>Apelido público<input name="nickname" required minLength={3} maxLength={24} placeholder="Ex.: Céu Noturno"/></label>
          <label>Cidade<select name="cityId" required defaultValue={params.get('city') ?? ''}>
            <option value="" disabled>Selecione</option>
            {cities.map(city => <option value={city.id} key={city.id}>{city.name} — {city.state}</option>)}
          </select></label>
          <p className="hint">As pessoas verão apenas apelido, faixa etária e cidade.</p>
        </>}
        <button className="primary" type="submit" disabled={mode === 'resend' && resending}>
          {mode === 'login' ? 'Entrar' : mode === 'register' ? 'Criar conta' : mode === 'verify' ? 'Confirmar e-mail' : mode === 'resend' ? (resending ? 'Enviando…' : 'Reenviar confirmação de e-mail') : 'Entrar na sala'}
        </button>
      </form>
      {mode === 'login' && <>
        <Link className="switch switch-link" to="/recuperar-senha">Esqueci minha senha?</Link>
        <button className="switch" type="button" onClick={() => changeMode('resend')}>Reenviar confirmação de e-mail</button>
        <button className="switch" type="button" onClick={() => changeMode('register')}>Ainda não tenho conta</button>
      </>}
      {mode === 'register' && <button className="switch" type="button" onClick={() => changeMode('login')}>Já tenho uma conta</button>}
      {mode === 'verify' && verificationEmail && <button className="switch" type="button" disabled={resending} onClick={() => requestVerification(verificationEmail)}>{resending ? 'Enviando…' : 'Reenviar confirmação de e-mail'}</button>}
      {mode === 'resend' && <button className="switch" type="button" onClick={() => changeMode('login')}>Voltar para entrar</button>}
    </section>
  </main>;
}
