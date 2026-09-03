import { FormEvent, useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from './api';

export function PasswordReset() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      if (!token) {
        const result = await api<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: form.get('email') })
        });
        setNotice(result.message);
        setFinished(true);
        return;
      }

      const password = String(form.get('password') ?? '');
      const confirmation = String(form.get('passwordConfirmation') ?? '');
      if (password !== confirmation) throw new Error('As senhas não coincidem.');
      const result = await api<{ message: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password })
      });
      setNotice(result.message);
      setFinished(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Erro inesperado.');
    }
  }

  return <main className="auth-page">
    <section className="auth-side">
      <Link to="/entrar"><ArrowLeft/> Voltar</Link>
      <div>
        <div className="brand">binger<span>.</span></div>
        <h1>Recupere o acesso<br/><em>com segurança.</em></h1>
        <p>O link é temporário, funciona uma única vez e não revela se um endereço está cadastrado.</p>
      </div>
      <small><ShieldCheck/> Suas sessões anteriores serão encerradas</small>
    </section>
    <section className="auth-card">
      <div className="step">Recuperação de conta</div>
      <h2>{token ? 'Defina uma nova senha' : 'Esqueceu sua senha?'}</h2>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!finished && <form onSubmit={submit}>
        {!token ? <>
          <label>E-mail<input name="email" type="email" required autoComplete="email"/></label>
          <p className="hint">Se houver uma conta elegível, enviaremos um link válido por 30 minutos.</p>
        </> : <>
          <label>Nova senha<input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password"/></label>
          <label>Confirme a nova senha<input name="passwordConfirmation" type="password" required minLength={10} maxLength={128} autoComplete="new-password"/></label>
          <p className="hint">Use pelo menos 10 caracteres.</p>
        </>}
        <button className="primary" type="submit">{token ? 'Redefinir senha' : 'Enviar instruções'}</button>
      </form>}
      <div className="auth-links"><Link to="/entrar">Voltar para o login</Link></div>
    </section>
  </main>;
}
