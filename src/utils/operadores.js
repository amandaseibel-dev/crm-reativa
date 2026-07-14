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
  // A planilha do Santander as vezes traz "Rafaela" (um L) para a mesma
  // operadora oficial "RAFAELLA" (cobranca12). Sem este alias, o nome com
  // um L nao casava com nenhum operador e o pagamento entrava sem
  // operador_email -> ficava fora do ranking/projecao da Rafaella. O alias
  // consolida a variacao no operador oficial ja no momento da importacao
  // (caixa e espacos ja sao tratados por normalizarNomeOperador).
  RAFAELA: "RAFAELLA",
};

function normalizarNomeOperador(nome) {
  const semAcento = String(nome || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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

// Fila de Baixas (comprovantes) -- Amanda continua podendo lançar baixa;
// Fernanda ganhou acesso pra visualizar/acompanhar a fila também.
export function podeVerFilaDeBaixas(email) {
  const chave = String(email || "").toLowerCase().trim();
  return chave === "amanda.seibel@aelbra.com.br" || chave === "cobranca04@aelbra.com.br";
}


export function podeAcessoRestritoAmanda(email) {
  return podeBaixarPagamento(email);
}

// Fila de envio ao financeiro: so a Amanda ADM mexe nisso no dia a dia,
// mas a Amanda gestora tambem enxerga para acompanhar.
export function podeGerirFinanceiro(email) {
  const chave = String(email || "").toLowerCase().trim();

  return [
    "cobranca07@aelbra.com.br",
    "amanda.seibel@aelbra.com.br",
    "cobranca04@aelbra.com.br",
  ].includes(chave);
}
