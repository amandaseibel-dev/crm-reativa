// Restrição de PILOTO para a leitura do histórico (não é regra permanente de carteira nem de responsabilidade).
//
// ULBRA_HISTORICO_HABILITADO liga o recurso para qualquer usuário que passe nas regras existentes.
// Para limitar o piloto às identidades explicitamente autorizadas, ULBRA_HISTORICO_PILOTO_EMAILS
// traz a lista (e-mails separados por vírgula). Fail-closed: lista ausente ou vazia = ninguém lê.
// A regra permanente (carteira, responsável, leitura global) continua valendo dentro da lista.

export function pilotoPermiteLeitura(email: string, listaBruta: string | null | undefined): boolean {
  if (!listaBruta || !listaBruta.trim()) return false;
  const alvo = email.trim().toLowerCase();
  if (!alvo) return false;
  const lista = listaBruta
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return lista.includes(alvo);
}
