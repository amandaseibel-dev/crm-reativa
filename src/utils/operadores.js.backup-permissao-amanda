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
