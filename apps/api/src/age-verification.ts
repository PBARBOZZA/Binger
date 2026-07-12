export interface AgeVerificationInput { birthDate: Date; adultDeclaration: boolean; emailVerified: boolean }
export interface AgeVerificationResult { approved: boolean; method: string; reason?: string }
export interface AgeVerificationProvider { verify(input: AgeVerificationInput): Promise<AgeVerificationResult> }

export function ageOn(date: Date, today = new Date()) {
  let age = today.getUTCFullYear() - date.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < date.getUTCMonth() ||
    (today.getUTCMonth() === date.getUTCMonth() && today.getUTCDate() < date.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export class BasicAgeVerificationProvider implements AgeVerificationProvider {
  async verify(input: AgeVerificationInput): Promise<AgeVerificationResult> {
    if (!input.adultDeclaration) return { approved: false, method: 'basic', reason: 'Declaração obrigatória.' };
    if (ageOn(input.birthDate) < 18) return { approved: false, method: 'basic', reason: 'Serviço exclusivo para maiores de 18 anos.' };
    if (!input.emailVerified) return { approved: false, method: 'basic', reason: 'Confirme o e-mail para concluir.' };
    return { approved: true, method: 'basic' };
  }
}

// Substitua por um adaptador externo que implemente AgeVerificationProvider. Guarde apenas o resultado e a referência externa, nunca documentos.
export const ageVerificationProvider: AgeVerificationProvider = new BasicAgeVerificationProvider();
