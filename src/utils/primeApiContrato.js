// Validadores de FORMA (não de valor) para as respostas da API Prime/ULBRA.
//
// Por que isto existe: docs/integracoes/prime-api.md documenta a forma de
// cada endpoint com base em medição real. Se a ULBRA mudar um campo (nome,
// tipo, presença), uma automação financeira pode quebrar em silêncio antes de
// alguém perceber. Este arquivo codifica o contrato documentado; o teste
// correspondente (primeApiContrato.test.js) valida fixtures estáticas contra
// ele. Não faz chamada de rede — ver docs/integracoes/README.md, seção
// "Como manter isto atualizado", para o processo de verificação ao vivo com
// a Edge Function `prime-sonda`.
//
// Quando um campo mudar de verdade em produção: atualizar a fixture do teste
// E os três documentos citados no mesmo commit (prime-api.md,
// prime-api-catalog.json, prime-mapa-fontes-verdade.md).

function erro(campo, motivo) {
  return `${campo}: ${motivo}`;
}

function validarCampos(obj, especificacao, prefixo = "") {
  const erros = [];
  if (obj === null || typeof obj !== "object") {
    return [erro(prefixo || "objeto", "não é um objeto")];
  }
  for (const [campo, regra] of Object.entries(especificacao)) {
    const valor = obj[campo];
    const caminho = prefixo ? `${prefixo}.${campo}` : campo;
    const presente = campo in obj;
    if (regra.obrigatorio && !presente) {
      erros.push(erro(caminho, "campo obrigatório ausente"));
      continue;
    }
    if (!presente) continue;
    if (regra.tipos && !regra.tipos.some((t) => checarTipo(valor, t))) {
      erros.push(erro(caminho, `tipo inesperado (esperado ${regra.tipos.join("|")}, veio ${tipoDe(valor)})`));
    }
  }
  return erros;
}

function checarTipo(valor, tipo) {
  if (tipo === "null") return valor === null;
  if (tipo === "array") return Array.isArray(valor);
  if (tipo === "object") return typeof valor === "object" && valor !== null && !Array.isArray(valor);
  return typeof valor === tipo;
}

function tipoDe(valor) {
  if (valor === null) return "null";
  if (Array.isArray(valor)) return "array";
  return typeof valor;
}

// GET /carriers — item de `items[]`
export const ESPEC_CARRIER = {
  id: { obrigatorio: true, tipos: ["number"] },
  name: { obrigatorio: true, tipos: ["string"] },
  covenant: { obrigatorio: false, tipos: ["string", "null"] },
  isCollectionAgency: { obrigatorio: false, tipos: ["boolean"] },
};

// GET /students?search=... — item de `items[]`
export const ESPEC_STUDENT_SEARCH_ITEM = {
  registration: { obrigatorio: true, tipos: ["string", "number"] },
  name: { obrigatorio: true, tipos: ["string"] },
  cpf: { obrigatorio: true, tipos: ["string"] },
};

// GET /students/{registration}/financial-statement — item de `items[]`
// (mesmos 13 campos aparecem em financialStatement[] do composto)
export const ESPEC_FINANCIAL_STATEMENT_ITEM = {
  boleto: { obrigatorio: true, tipos: ["string"] },
  documentNumber: { obrigatorio: false, tipos: ["string"] },
  carrier: { obrigatorio: true, tipos: ["object"] },
  dueDate: { obrigatorio: false, tipos: ["string", "null"] },
  paymentDate: { obrigatorio: false, tipos: ["string", "null"] },
  grossAmount: { obrigatorio: false, tipos: ["number", "null"] },
  discountAmount: { obrigatorio: false, tipos: ["number", "null"] },
  penaltyAmount: { obrigatorio: false, tipos: ["number", "null"] },
  interestAmount: { obrigatorio: false, tipos: ["number", "null"] },
  honorariumAmount: { obrigatorio: false, tipos: ["number", "null"] },
  netAmount: { obrigatorio: false, tipos: ["number", "null"] },
  paidAmount: { obrigatorio: false, tipos: ["number", "null"] },
  isAgreementInstallment: { obrigatorio: false, tipos: ["boolean"] },
};

// GET /students/{registration} — objeto composto, nível superior
export const ESPEC_STUDENT_COMPOSITE = {
  registrationData: { obrigatorio: true, tipos: ["object"] },
  contracts: { obrigatorio: true, tipos: ["array"] },
  financialStatement: { obrigatorio: true, tipos: ["array"] },
  agreements: { obrigatorio: true, tipos: ["array"] },
};

// GET /students/{registration}/agreements — envelope de paginação
export const ESPEC_PAGINATED_ENVELOPE = {
  items: { obrigatorio: true, tipos: ["array"] },
  totalItems: { obrigatorio: true, tipos: ["number"] },
};

export function validarCarrier(obj) {
  return validarCampos(obj, ESPEC_CARRIER, "carrier");
}

export function validarStudentSearchItem(obj) {
  return validarCampos(obj, ESPEC_STUDENT_SEARCH_ITEM, "students_search.item");
}

export function validarFinancialStatementItem(obj) {
  return validarCampos(obj, ESPEC_FINANCIAL_STATEMENT_ITEM, "financial_statement.item");
}

export function validarStudentComposite(obj) {
  return validarCampos(obj, ESPEC_STUDENT_COMPOSITE, "student_composite");
}

export function validarEnvelopePaginado(obj, rotulo = "envelope") {
  return validarCampos(obj, ESPEC_PAGINATED_ENVELOPE, rotulo);
}

// Regra documentada: /agreements sempre respondeu vazio em todos os testes
// realizados (ver docs/integracoes/prime-gaps.md). Este validador não afirma
// que DEVE continuar vazio — só confirma que, SE a forma mudar para conter
// itens, o formato de cada item bate com o schema já visto em
// financial_statement, para não gravar dado desconhecido sem checagem.
export function validarAgreementsResponse(obj) {
  const erros = validarEnvelopePaginado(obj, "agreements");
  if (Array.isArray(obj?.items) && obj.items.length > 0) {
    erros.push(
      `agreements.items: ${obj.items.length} item(ns) recebido(s) — agreements deixou de vir vazio. ` +
        "Atualizar docs/integracoes/prime-api.md, prime-api-catalog.json e prime-gaps.md antes de mapear ou usar este campo.",
    );
  }
  return erros;
}
