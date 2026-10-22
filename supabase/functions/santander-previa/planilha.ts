// SANTANDER · NORMALIZAÇÃO DA PLANILHA, DO LADO DO SERVIDOR
// -----------------------------------------------------------------------------
// ENTREGA A do caminho Santander -> CRM. Só LÊ e normaliza: nenhuma função
// daqui escreve, chama RPC ou toca em `pagamentos`.
//
// POR QUE ESTE ARQUIVO EXISTE. Hoje o `.xls` do extrato é lido NO NAVEGADOR, em
// `src/pages/ProjecaoHoraHora.jsx` (`normalizarLinhaSantander` + `linhaTemDado`),
// e alguém sobe o arquivo à mão -- 484 importações desde 07/07/2026, 4,5 por dia
// nos últimos 30 dias, 9 só em 21/10. Para a entrada deixar de ser manual, a
// mesma normalização precisa rodar no servidor.
//
// O CONTRATO NÃO FOI REINVENTADO: é a transcrição da lógica do navegador, campo
// a campo, com as decisões já tomadas e os seus porquês preservados. Há teste
// que compara esta implementação com a do navegador, caso a caso, e teste que
// confere o resultado contra pagamentos históricos reais.
//
// NÃO ALTERA REGRA FINANCEIRA. Quem decide vínculo, conciliação e baixa continua
// sendo o motor (`pagamento_conciliar_um`), acionado pelos gatilhos de
// `pagamentos`. Este arquivo para na borda: produz as linhas e devolve.
//
// SEM DEPENDÊNCIA DE PLANILHA AQUI, DE PROPÓSITO. A leitura do `.xls` (XLSX)
// fica no `index.ts`; aqui entram LINHAS JÁ EXTRAÍDAS (array de arrays). É a
// mesma divisão do `prime-sonda` (portao.ts separado do index.ts), e é o que
// permite testar a normalização inteira sem abrir arquivo nem ir à rede.

// -----------------------------------------------------------------------------
// LIMITES E VALIDAÇÃO DE ARQUIVO
// -----------------------------------------------------------------------------
// O arquivo real é pequeno: os 10.636 pagamentos históricos vieram em lotes de
// 4 a 39 linhas, e a maior importação de todas teve 506 (a correção de
// duplicidade de 07/07). 5 MiB é folga de ordens de grandeza sobre o maior lote
// plausível, e ainda recusa qualquer coisa que não seja planilha.
export const LIMITE_BYTES = 5 * 1024 * 1024;
export const LIMITE_LINHAS = 20000;
export const LIMITE_NOME = 160;

// Assinaturas conferidas nos BYTES, não na extensão -- extensão é o que o
// remetente diz, assinatura é o que o arquivo é.
//   XLS  (BIFF8/OLE2):  D0 CF 11 E0 A1 B1 1A E1
//   XLSX (ZIP/OOXML):   50 4B 03 04   ("PK\x03\x04")
const ASSINATURA_XLS = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ASSINATURA_ZIP = [0x50, 0x4b, 0x03, 0x04];

function comecaCom(bytes: Uint8Array, assinatura: number[]): boolean {
  if (bytes.length < assinatura.length) return false;
  for (let i = 0; i < assinatura.length; i++) {
    if (bytes[i] !== assinatura[i]) return false;
  }
  return true;
}

export function ehPlanilha(bytes: Uint8Array): boolean {
  return comecaCom(bytes, ASSINATURA_XLS) || comecaCom(bytes, ASSINATURA_ZIP);
}

export type Recusa = { ok: false; erro: string; detalhe?: string };
export type Aceite = { ok: true; formato: "xls" | "xlsx" };

export function validarArquivo(bytes: Uint8Array | null, nome: string): Recusa | Aceite {
  if (!bytes || bytes.length === 0) return { ok: false, erro: "ARQUIVO_VAZIO" };
  if (bytes.length > LIMITE_BYTES) {
    return { ok: false, erro: "ARQUIVO_GRANDE", detalhe: `${bytes.length} bytes; limite ${LIMITE_BYTES}` };
  }
  if (String(nome || "").length > LIMITE_NOME) {
    return { ok: false, erro: "NOME_LONGO", detalhe: `limite ${LIMITE_NOME}` };
  }
  if (!ehPlanilha(bytes)) {
    return { ok: false, erro: "NAO_E_PLANILHA", detalhe: "assinatura não é XLS (OLE2) nem XLSX (ZIP)" };
  }
  return { ok: true, formato: comecaCom(bytes, ASSINATURA_XLS) ? "xls" : "xlsx" };
}

// -----------------------------------------------------------------------------
// MAPA DE OPERADORES -- transcrito de src/utils/operadores.js
// -----------------------------------------------------------------------------
// Transcrito, e não importado, porque o navegador é ESM do bundle e esta função
// roda em Deno. O teste confere os DOIS lados contra a mesma tabela, então uma
// divergência futura aparece como teste vermelho, não como pagamento sem
// operador.
export const OPERADORES_POR_EMAIL: Record<string, string> = {
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

// Os três aliases, com o motivo original preservado:
//   NATALY        -- a planilha escreve com Y; o cadastro oficial é NATALI.
//   RAFAELA       -- a planilha às vezes traz um L só; sem o alias o pagamento
//                    entrava sem operador_email e ficava fora do ranking dela.
//   AMANDA.BORGES -- decisão de 30/07/2026: tudo que entra como "Amanda Borges"
//                    é da Amanda ADM (cobranca07). O primeiro nome "AMANDA" é
//                    ambíguo entre ADM e gestora, por isso o alias é pelo login
//                    COMPLETO -- e a resolução tenta o nome inteiro ANTES de
//                    cair para o primeiro nome.
const ALIAS_NOME_OPERADOR: Record<string, string> = {
  NATALY: "NATALI",
  RAFAELA: "RAFAELLA",
  "AMANDA.BORGES": "AMANDA ADM",
};

function normalizarNomeOperador(nome: unknown): string {
  const semAcento = String(nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
  return ALIAS_NOME_OPERADOR[semAcento] || semAcento;
}

export function emailPorNomeOperador(nomeArquivo: unknown): string | null {
  const alvo = normalizarNomeOperador(nomeArquivo);
  if (!alvo) return null;

  for (const [email, nome] of Object.entries(OPERADORES_POR_EMAIL)) {
    if (normalizarNomeOperador(nome) === alvo) return email;
  }

  if (alvo.includes(".")) return emailPorNomeOperador(alvo.split(".")[0]);

  return null;
}

export function nomeOperadorPorEmail(email: unknown): string {
  const chave = String(email ?? "").toLowerCase().trim();
  return OPERADORES_POR_EMAIL[chave] || (email as string) || "OPERADOR";
}

// -----------------------------------------------------------------------------
// DATAS -- os três formatos que a planilha produz
// -----------------------------------------------------------------------------
// `Date` quando o leitor usa cellDates; número quando vem o serial do Excel;
// texto dd/mm/aaaa em alguns arquivos.
//
// A conversão do serial é feita AQUI, sem `XLSX.SSF`, para o parser não
// precisar da biblioteca de planilha e poder ser testado sozinho. Serial 1 =
// 1900-01-01, com o bug histórico do 29/02/1900 que o Excel mantém -- por isso
// o desconto de um dia a partir do serial 61. Há teste comparando esta conta
// com `XLSX.SSF.parse_date_code` nos seriais reais do histórico.
export function paraDataISO(valor: unknown): string | null {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor <= 0) return null;
    const dias = Math.floor(valor);
    const base = Date.UTC(1899, 11, 31);
    const ms = base + (dias - (dias >= 61 ? 1 : 0)) * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof valor === "string" && valor.includes("/")) {
    const [dia, mes, ano] = valor.split("/");
    if (!dia || !mes || !ano) return null;
    return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  }
  return null;
}

// -----------------------------------------------------------------------------
// A LINHA
// -----------------------------------------------------------------------------
// Colunas FIXAS POR POSIÇÃO -- a planilha não tem cabeçalho de verdade (a linha
// 1, quando existe, é só um título "Data de Pagamento: ..."):
//
//   A instituição | B "matrícula - nome do aluno" | C título | D operador
//   (NOME.SOBRENOME) | E código convênio+título | F convênio | G vencimento da
//   parcela | H valor original | I honorário | J data de pagamento | K valor pago
export interface LinhaNormalizada {
  data_pagamento: string | null;
  valor_pago: number;
  valor_honorario: number;
  tipo_pagamento: "SANTANDER";
  titulo_numero: string | null;
  numero_parcela_completo: string | null;
  vencimento: string | null;
  valor_original: number | null;
  operador_email: string | null;
  operador_nome: string | null;
  aluno_nome: string | null;
  matricula: string | null;
  cpf: null;
}

export function normalizarLinhaSantander(linhaArray: unknown[]): LinhaNormalizada {
  const [
    ,
    alunoBruto,
    tituloNumero,
    operadorBruto,
    numeroParcelaCompleto,
    ,
    vencimento,
    valorOriginal,
    honorario,
    dataPagamento,
    valorPago,
  ] = linhaArray;

  const emailOperador = emailPorNomeOperador(operadorBruto);

  // Coluna B vem como "2026002333 - Nome do Aluno". A matrícula já foi JOGADA
  // FORA aqui uma vez: ficava só o nome, o pagamento entrava sem identificador
  // que casasse com o aluno -- nem CPF, nem matrícula -- e 3.272 pagamentos do
  // mês ficaram sem vínculo, com o único casamento possível sendo por nome,
  // que erra em homônimo.
  let aluno = String(alunoBruto ?? "");
  let matricula: string | null = null;
  const partesAluno = aluno.split(" - ");
  if (partesAluno.length > 1) {
    const prefixo = partesAluno[0].trim();
    // Só aceita como matrícula se for número: há nome de aluno com " - " no
    // meio, e ali o prefixo é parte do nome, não matrícula.
    if (/^[0-9]{3,}$/.test(prefixo)) matricula = prefixo;
    aluno = partesAluno.slice(1).join(" - ");
  }

  return {
    data_pagamento: paraDataISO(dataPagamento),
    valor_pago: Number(valorPago) || 0,
    valor_honorario: Number(honorario) || 0,
    tipo_pagamento: "SANTANDER",
    titulo_numero: tituloNumero ? String(tituloNumero) : null,
    // Identificador ÚNICO por parcela (ex.: 50640510001). Um mesmo
    // titulo_numero pode ter várias parcelas, então NUNCA usar titulo_numero
    // como chave de dedup -- só esta coluna é de fato única por parcela/boleto,
    // e é ela que sustenta o índice `uq_pagamentos_parcela_valor_data`.
    numero_parcela_completo: numeroParcelaCompleto ? String(numeroParcelaCompleto) : null,
    vencimento: paraDataISO(vencimento),
    valor_original: Number(valorOriginal) || null,
    operador_email: emailOperador,
    operador_nome: emailOperador ? nomeOperadorPorEmail(emailOperador) : ((operadorBruto as string) || null),
    aluno_nome: aluno || null,
    matricula,
    cpf: null,
  };
}

// Descarta a linha de título SEM depender de posição fixa. Antes o navegador
// pulava sempre a linha 0, e ALGUNS arquivos vêm sem título -- a 1ª linha já era
// pagamento de verdade e estava sendo descartada (2 pagamentos no arquivo, 1
// carregado).
export function linhaTemDado(linha: unknown[] | null | undefined): boolean {
  const valorPago = linha?.[10];
  const temValorPago = typeof valorPago === "number" && valorPago !== 0;
  if (temValorPago) return true;

  // Rede de segurança: coluna K não numérica, mas a linha claramente tem
  // aluno + data de pagamento.
  const aluno = linha?.[1];
  const dataPagamento = linha?.[9];
  const temAluno = typeof aluno === "string" && aluno.trim() !== "";
  const temData = dataPagamento instanceof Date || typeof dataPagamento === "number";
  return temAluno && temData;
}

export function normalizarPlanilha(linhasBrutas: unknown[][]): LinhaNormalizada[] {
  return linhasBrutas.filter(linhaTemDado).map(normalizarLinhaSantander);
}

// -----------------------------------------------------------------------------
// IMPRESSÃO DIGITAL DO CONTEÚDO NORMALIZADO
// -----------------------------------------------------------------------------
// ENTREGA B. Serve a uma pergunta só: *o que a gestão aprovou na prévia é o que
// vai ser importado?*
//
// NÃO É AUTENTICAÇÃO. Qualquer um pode calcular este hash -- ele não prova quem
// chamou, prova QUAL CONTEÚDO. Quem autentica é o JWT no gateway e o portão de
// gestão; quem autoriza a escrita é a RPC, que confere `auth.email()` contra a
// sua própria allowlist. A digital resolve outra coisa: entre ver a prévia e
// confirmar, o arquivo pode ter sido trocado -- outro dia, outra remessa, ou
// simplesmente o seletor de arquivo apontando para o lugar errado. Sem ela, a
// confirmação importaria o arquivo NOVO com a conferência do ANTIGO.
//
// POR QUE AS CHAVES VÃO ORDENADAS, e não numa lista fixa de campos: campo novo
// no normalizador passa a ser coberto automaticamente. Com lista fixa, alguém
// acrescenta um campo, esquece de incluir aqui, e a digital deixa de enxergar
// justamente a parte nova -- falha silenciosa, do tipo pior.
//
// A contagem de linhas entra explicitamente no texto assinado: hash de conteúdo
// mais a quantidade, para que nenhuma reorganização de linhas produza a mesma
// digital por acidente.
export function textoParaDigital(linhas: LinhaNormalizada[]): string {
  const canonica = linhas.map((l) => {
    const registro = l as unknown as Record<string, unknown>;
    return Object.keys(registro)
      .sort()
      .map((k) => [k, registro[k] ?? null]);
  });
  return JSON.stringify({ n: linhas.length, linhas: canonica });
}

export async function impressaoDigital(linhas: LinhaNormalizada[]): Promise<string> {
  const bytes = new TextEncoder().encode(textoParaDigital(linhas));
  const resumo = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(resumo))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Comparação de digitais sem ramificar por byte. A digital não é segredo, mas
// comparar hash com `===` é um hábito que em outro contexto vaza tempo -- e o
// custo de fazer certo aqui é zero.
export function digitalConfere(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}
