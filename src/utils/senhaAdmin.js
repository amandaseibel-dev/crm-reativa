// Validação da senha definida por gestão para outro usuário.
// Regra mínima: 10 a 128 caracteres, com letra e número. Não aceita espaços
// no começo ou no fim. Função pura, usada na tela e testada isoladamente.
export const TAMANHO_MIN_SENHA = 10;
export const TAMANHO_MAX_SENHA = 128;

export function validarNovaSenha(senha) {
  if (typeof senha !== "string") return { ok: false, motivo: "Informe a senha." };
  if (senha.length < TAMANHO_MIN_SENHA) {
    return { ok: false, motivo: `A senha precisa ter pelo menos ${TAMANHO_MIN_SENHA} caracteres.` };
  }
  if (senha.length > TAMANHO_MAX_SENHA) {
    return { ok: false, motivo: `A senha pode ter no máximo ${TAMANHO_MAX_SENHA} caracteres.` };
  }
  if (senha !== senha.trim()) return { ok: false, motivo: "A senha não pode começar nem terminar com espaço." };
  if (!/[A-Za-zÀ-ÿ]/.test(senha) || !/[0-9]/.test(senha)) {
    return { ok: false, motivo: "A senha precisa ter pelo menos uma letra e um número." };
  }
  return { ok: true, motivo: "" };
}
