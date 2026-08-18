export const OPERADORES_POR_EMAIL = {
  "cobranca03@aelbra.com.br": "OLGA",
  "cobranca04@aelbra.com.br": "FERNANDA",
  "cobranca05@aelbra.com.br": "LUANA",
  "cobranca06@aelbra.com.br": "MAURÍCIO",
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

// Quem enxerga a carteira inteira (e não só a própria). Além da allowlist de
// gestão, o perfil "diretoria" vê tudo -- é leitura de resultado da empresa,
// então o Panorama 360 abre consolidado. O dado em si vem de RPCs agregadas
// (dashboard_carteira_360 / dashboard_gestao_geral), que não expõem carteira
// de operador individual.
export function podeVerTudo(email, perfil) {
  const chave = String(email || "").toLowerCase().trim();

  if (String(perfil || "").toLowerCase().trim() === "diretoria") return true;

  return [
    "cobranca04@aelbra.com.br",
    "cobranca07@aelbra.com.br",
    "amanda.seibel@aelbra.com.br",
  ].includes(chave);
}

// Fila de Acordos: quem pode vincular/trocar o acordo_id de uma linha da fila.
// Mesmo allowlist de gestão (Amanda gestora, Amanda ADM, Fernanda). A regra
// definitiva é aplicada no banco (public.fila_acordos_pode_vincular); aqui é
// apenas para mostrar/ocultar o controle na interface.
export function podeVincularAcordoFila(email) {
  return podeVerTudo(email);
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

// -------------------------------------------------------------------------
// Projecao — equipe dos 9 (8 operadores + Amanda ADM). Amanda ADM (cobranca07)
// participa com resultado individual (8% fixo). A regra definitiva e aplicada
// no banco (snapshot por operador). Aqui e so para montar seletores/rotulos.
// -------------------------------------------------------------------------
export const EQUIPE_9_EMAILS = [
  "cobranca03@aelbra.com.br", // OLGA
  "cobranca05@aelbra.com.br", // LUANA
  "cobranca06@aelbra.com.br", // MAURÍCIO
  "cobranca08@aelbra.com.br", // NATALI
  "cobranca10@aelbra.com.br", // JOÃO
  "cobranca11@aelbra.com.br", // ALLAN
  "cobranca12@aelbra.com.br", // RAFAELLA
  "cobranca13@aelbra.com.br", // DIEGO
  "cobranca07@aelbra.com.br", // AMANDA ADM
];

// Seletor de operador para a gestao: exatamente os 9, na ordem oficial.
export const EQUIPE_9 = EQUIPE_9_EMAILS.map((email) => ({
  email,
  nome: OPERADORES_POR_EMAIL[email] || email,
}));

export function ehEquipe9(email) {
  return EQUIPE_9_EMAILS.includes(String(email || "").toLowerCase().trim());
}

// Central de Relatorios: EXCLUSIVA de Amanda gestora e Fernanda. Espelha a
// autorizacao do backend (RPC geral e exportacao). Amanda ADM NAO exporta.
export function podeVerRelatorios(email) {
  const chave = String(email || "").toLowerCase().trim();
  return chave === "amanda.seibel@aelbra.com.br" || chave === "cobranca04@aelbra.com.br";
}

// Rotulo amigavel das classificacoes do relatorio geral de pagamentos.
export const ROTULO_CLASSIFICACAO = {
  EQUIPE_9: "Integrante da equipe",
  FERNANDA: "Fernanda",
  PAGAMENTO_DIRETO: "Pagamento direto",
  SEM_OPERADOR: "Sem operador",
  OUTRO: "Outro",
};
