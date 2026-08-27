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

// ---------------------------------------------------------------
// Limpeza do telefone CADASTRADO (ficha, discagem, wa.me).
//
// POR QUE NÃO MEXER EM `normalizarE164`: aquela função é a chave de
// conversa da Central e espelha, dígito a dígito, a função SQL
// `whatsapp_normalizar_telefone`. Mudar a regra lá abriria conversa
// nova para gente que já tem histórico. Aqui é outro problema: o
// cadastro do CRM tem número sujo, e a sujeira precisa sair ANTES de
// virar link de WhatsApp -- senão o operador liga para o número errado.
//
// A regra é a mesma já usada em Ações Massivas (formato 55 + DDD + número).
// ---------------------------------------------------------------

// Tira o DDD repetido e completa o 9º dígito. Devolve só os dígitos.
function limparCadastro(telefone) {
  let d = String(telefone ?? "").replace(/\D/g, "");
  if (!d) return "";

  // DDD duplicado: "(51) (51) 8110-4056" -> 515181104056 -> 5181104056
  if (d.length === 13 && d.slice(0, 2) === d.slice(2, 4)) d = d.slice(2);
  if (d.length === 12 && d.slice(0, 2) === d.slice(2, 4) && d.slice(4, 5) !== "9")
    d = d.slice(2);

  // Celular antigo sem o 9º dígito: DDD + 8 -> DDD + 9 dígitos.
  // (Fixo tem o mesmo tamanho e também é "corrigido", mas fixo não
  // recebe WhatsApp de qualquer jeito.)
  if (d.length === 10) d = d.slice(0, 2) + "9" + d.slice(2);

  return d;
}

// Telefone do cadastro pronto para discar/abrir no WhatsApp: 55 + DDD + número.
export function normalizarCadastro(telefone) {
  return normalizarE164(limparCadastro(telefone));
}

// Exibição do telefone do cadastro na ficha: +55 (51) 98110-4056
export function formatarCadastro(telefone) {
  const limpo = limparCadastro(telefone);
  if (!limpo) return "";
  return formatarTelefone(limpo);
}
