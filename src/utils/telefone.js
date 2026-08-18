// Normalização de telefone para a Central WhatsApp.
//
// Espelha, no frontend, a mesma regra da função SQL
// `whatsapp_normalizar_telefone`.
//
// PARA QUE SERVE: chave estável da conversa e exibição na tela. NÃO serve para
// achar aluno — a Central não tem vínculo com ficha, caso ou carteira. Sem a
// normalização, o mesmo telefone chegando em formatos diferentes abriria
// conversas duplicadas para a mesma pessoa.

// Só os dígitos, com DDI 55 na frente quando parece número brasileiro.
// Devolve "" quando não dá para aproveitar.
export function normalizarE164(telefone) {
  const d = String(telefone ?? "").replace(/\D/g, "");
  if (!d || d.length < 10) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

// Exibição amigável: +55 (51) 99999-8888
export function formatarTelefone(telefone) {
  const e164 = normalizarE164(telefone);
  if (!e164) return String(telefone ?? "");
  if (!e164.startsWith("55")) return "+" + e164;

  const ddd = e164.slice(2, 4);
  const resto = e164.slice(4);
  if (resto.length === 9) return `+55 (${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
  if (resto.length === 8) return `+55 (${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
  return "+" + e164;
}
