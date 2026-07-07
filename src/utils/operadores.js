export const OPERADORES_POR_EMAIL = {
  "cobranca03@aelbra.com.br": "OLGA",
  "cobranca04@aelbra.com.br": "FERNANDA",
  "cobranca05@aelbra.com.br": "LUANA",
  "cobranca06@aelbra.com.br": "MAURICIO",
  "cobranca07@aelbra.com.br": "AMANDA ADM",
  "cobranca08@aelbra.com.br": "NATALI",
  "cobranca10@aelbra.com.br": "JOÃO",
  "cobranca11@aelbra.com.br": "ALLAN",
  "cobranca12@aelbra.com.br": "RAFAELLA",
  "cobranca13@aelbra.com.br": "DIEGO",
  "amanda.seibel@aelbra.com.br": "AMANDA GESTORA",
};

const ALIAS_NOME_OPERADOR = {
  NATALY: "NATALI",
  RAFAELA: "RAFAELLA",
  "RAFAELA COIMBRA": "RAFAELLA",
};

function normalizarNomeOperador(nome) {
  const semAcento = String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
  return ALIAS_NOME_OPERADOR[semAcento] || semAcento;
}

export function emailPorNomeOperador(nomeArquivo) {
  const alvo = normalizarNomeOperador(nomeArquivo);
  if (!alvo) return null;

  for (const [email, nome] of Object.entries(OPERADORES_POR_EMAIL)) {
    if (normalizarNomeOperador(nome) === alvo) return email;
  }

  return null;
}

export function nomeOperadorPorEmail(email) {
  const chave = String(email || "").toLowerCase().trim();
  return OPERADORES_POR_EMAIL[chave] || email || "OPERADOR";
}

export function podeVerTudo(email) {
  const chave = String(email || "").toLowerCase().trim();

  return [
    "cobranca04@aelbra.com.br",
    "cobranca07@aelbra.com.br",
    "amanda.seibel@aelbra.com.br",
  ].includes(chave);
}

export function podeBaixarPagamento(email) {
  const chave = String(email || "").toLowerCase().trim();
  return chave === "amanda.seibel@aelbra.com.br";
}


export function podeAcessoRestritoAmanda(email) {
  return podeBaixarPagamento(email);
}

// Fila de envio ao financeiro: so a Amanda ADM mexe nisso no dia a dia,
// mas a Amanda gestora tambem enxerga para acompanhar.
// Os 8 operadores com acesso ao ranking "Operadores x Direto". Qualquer
// pagamento cujo operador não esteja nessa lista (ou sem operador/tabulação)
// entra agregado como "Direto" nos rankings e relatórios.
export const EMAILS_RANKING_OPERADORES = [
  "cobranca03@aelbra.com.br", // Olga
  "cobranca05@aelbra.com.br", // Luana
  "cobranca06@aelbra.com.br", // Mauricio
  "cobranca08@aelbra.com.br", // Nataly
  "cobranca10@aelbra.com.br", // João
  "cobranca11@aelbra.com.br", // Allan
  "cobranca13@aelbra.com.br", // Diego
  "cobranca12@aelbra.com.br", // Rafaela
];

export function ehOperadorDeRanking(email) {
  const chave = String(email || "").toLowerCase().trim();
  return EMAILS_RANKING_OPERADORES.includes(chave);
}

export function podeGerirFinanceiro(email) {
  const chave = String(email || "").toLowerCase().trim();

  return [
    "cobranca07@aelbra.com.br",
    "amanda.seibel@aelbra.com.br",
    "cobranca04@aelbra.com.br",
  ].includes(chave);
}
