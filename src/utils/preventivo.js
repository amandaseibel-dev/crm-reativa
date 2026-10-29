// Regras puras do Preventivo que a TELA precisa antes de falar com o banco:
// reconhecer as colunas do relatório, normalizar contato e montar o arquivo da
// mensageria.
//
// A normalização de celular aqui é a MESMA de
// `public.preventivo_normalizar_celular` (migration 20260928143843). Duas
// cópias existem porque a prévia precisa responder sem ida ao banco; o teste
// `preventivo.test.js` compara as duas com os mesmos casos para que não se
// separem em silêncio.

// -----------------------------------------------------------------------------
// Contato
// -----------------------------------------------------------------------------
// 55 + DDD + 9 + 8 dígitos, só dígitos. Fixo NÃO passa e número incompleto NÃO
// é completado: inventar dígito é mandar mensagem para um desconhecido.
export function normalizarCelular(bruto) {
  let d = String(bruto ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  // 0 de operadora na frente do DDD (0 51 9 9999-0001)
  if (d.length === 12 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (d[2] !== "9") return null;
  return "55" + d;
}

// O campo Telefone do relatório real traz VÁRIOS números numa string só:
//   "(51) 99547-2585, CEL:(51) 991859609, CEL:5192568106, RES:51991859609"
// Ler todos e devolver os DISTINTOS não é adivinhar — adivinhar seria escolher
// um quando há dois diferentes. Medido no arquivo de 28/09/2026: 2.688 linhas
// com exatamente um celular válido, 402 com mais de um, 405 com nenhum.
export function celularesDoCampo(bruto) {
  const pedacos = String(bruto ?? "").match(/[\d()\s.-]{8,}/g) || [];
  // ordenado para bater, item a item, com `public.preventivo_celulares()`
  return [...new Set(pedacos.map(normalizarCelular).filter(Boolean))].sort();
}

// Mesma ideia para e-mail: no arquivo de 28/09/2026, 2.725 linhas trazem mais
// de um endereço (em geral o pessoal e o @rede.ulbra.br), 742 trazem um só.
export function emailsDoCampo(bruto) {
  const pedacos = String(bruto ?? "").split(/[;,\s]+/).map((x) => x.trim());
  return [...new Set(pedacos.filter(emailValido).map((x) => x.toLowerCase()))].sort();
}

export function emailValido(bruto) {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(bruto ?? "").trim());
}

// -----------------------------------------------------------------------------
// Leitura do relatório
// -----------------------------------------------------------------------------
// Os campos que o Preventivo precisa, com os nomes que o relatório do Prime e
// as exportações do Santander usam. `obrigatorio` é o que a importação recusa
// quando falta — nome do aluno NÃO identifica título, então nunca é chave.
export const CAMPOS = [
  { id: "matricula",   rotulo: "Matrícula / identificador do aluno", obrigatorio: true,
    apelidos: ["matricula", "matrícula", "codigo", "código", "registration", "registro", "codigo do aluno", "código do aluno", "ra"] },
  { id: "aluno_nome",  rotulo: "Nome do aluno", obrigatorio: true,
    apelidos: ["nome", "aluno", "nome do aluno", "nome aluno", "cliente", "sacado"] },
  { id: "vencimento",  rotulo: "Vencimento atual do boleto", obrigatorio: true,
    apelidos: ["dt vcto", "dt vencimento", "data vcto", "vencimento", "data de vencimento", "duedate", "venc"] },
  { id: "vencimento_origem", rotulo: "Vencimento de origem", obrigatorio: false,
    apelidos: ["vcto origem", "vencimento origem", "vencimento de origem", "dt origem", "origem"] },
  { id: "saldo",       rotulo: "Saldo em aberto (valor de entrada)", obrigatorio: true,
    apelidos: ["saldo original", "saldo", "saldo em aberto", "valor em aberto", "em aberto", "saldo devedor"] },
  { id: "saldo_atualizado", rotulo: "Saldo atualizado (com encargos)", obrigatorio: false,
    apelidos: ["saldo atualizado", "saldo corrigido", "valor atualizado"] },
  { id: "documento",   rotulo: "Identificador do título (boleto / documento), se houver", obrigatorio: false,
    apelidos: ["boleto", "documento", "nosso numero", "nosso número", "titulo", "título", "numero do titulo", "número do título", "documentnumber"] },
  { id: "valor",       rotulo: "Valor original do título", obrigatorio: false,
    apelidos: ["valor", "valor do titulo", "valor do título", "valor original", "netamount", "valor nominal"] },
  { id: "competencia", rotulo: "Competência", obrigatorio: false,
    apelidos: ["competencia", "competência", "referencia", "referência", "semestre", "parcela"] },
  { id: "situacao",    rotulo: "Situação financeira", obrigatorio: false,
    apelidos: ["situacao", "situação", "status", "situacao financeira", "situação financeira", "situacao academica", "situação acadêmica"] },
  { id: "cpf",         rotulo: "CPF", obrigatorio: false,
    apelidos: ["cpf", "documento do aluno"] },
  { id: "celular",     rotulo: "Celular", obrigatorio: false,
    apelidos: ["celular", "telefone", "fone", "whatsapp", "telefone celular", "contato"] },
  { id: "email",       rotulo: "E-mail", obrigatorio: false,
    apelidos: ["email", "e-mail", "correio eletronico", "correio eletrônico"] },
  { id: "unidade",     rotulo: "Unidade", obrigatorio: false,
    apelidos: ["estabelecimento", "unidade", "campus", "establishment", "polo", "pólo", "escola"] },
  { id: "contrato",    rotulo: "Contrato", obrigatorio: false,
    apelidos: ["processo", "contrato", "numero do contrato", "número do contrato"] },
];

// O RELATÓRIO REAL DA ULBRA, medido em 28/09/2026
// ("relatorio_inadimplencia 28.09.csv", 3.494 linhas):
//
//   Código · Nome do Aluno · Curso · Dt Vcto · Vcto Origem · Responsável ·
//   E-mail · Telefone · Endereço · Saldo Original · Saldo Atualizado ·
//   Estabelecimento · Processo · Escola · Situação Acadêmica · Tipo de Boleto
//
// Três coisas que esse cabeçalho ensina, e que mandam no desenho:
//
// 1. `Código` é a MATRÍCULA do aluno (a `registration` do Prime), não um
//    identificador de título: das 120 linhas conferidas contra o espelho de
//    produção, 101 tinham a matrícula presente e todas as 101 casaram com
//    título do aluno no portador 95.
// 2. NÃO EXISTE identificador de título. Por isso `documento` é opcional e a
//    identidade dentro da carteira é vencimento + vencimento de origem.
// 3. `Dt Vcto` é o vencimento ATUAL do boleto e `Vcto Origem` é o da
//    mensalidade que o originou. Nas 35 linhas em que as duas divergem, 21
//    tinham o aluno no espelho e as 21 casaram com o Prime por `Dt Vcto`;
//    nenhuma casou só por `Vcto Origem`. É `Dt Vcto` que rege a janela.

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const chave = (s) => semAcento(s).toLowerCase().replace(/\s+/g, " ").trim();

// Colunas que DESCREVEM um campo em vez de conter o campo. No relatório real,
// "Tipo de Boleto" vale "Mensalidade" ou "Matrícula" — não é o número do
// boleto, e casá-la com o identificador do título faria a carteira inteira
// entrar com o identificador errado. Descoberto rodando o arquivo de
// 28/09/2026 pelo importador.
const DESCRITIVA = /^(tipo|classe|especie|espécie|natureza|forma) (de|do|da) /;

// Sugestão de mapeamento, nunca imposição: a tela mostra o que adivinhou e a
// gestão troca antes da prévia.
export function sugerirMapeamento(cabecalho) {
  const cols = (cabecalho ?? []).map((c, i) => ({ i, k: chave(c) }))
    .filter((c) => !DESCRITIVA.test(c.k));
  const usadas = new Set();
  const mapa = {};
  for (const campo of CAMPOS) {
    const exato = cols.find((c) => !usadas.has(c.i) && campo.apelidos.includes(c.k));
    const parcial = exato || cols.find((c) => !usadas.has(c.i) && c.k &&
      campo.apelidos.some((a) => c.k === a || c.k.startsWith(a + " ") || c.k.endsWith(" " + a)));
    if (parcial) { mapa[campo.id] = parcial.i; usadas.add(parcial.i); }
  }
  return mapa;
}

export function camposObrigatoriosFaltando(mapa) {
  return CAMPOS.filter((c) => c.obrigatorio && !(c.id in (mapa ?? {}))).map((c) => c.rotulo);
}

// -----------------------------------------------------------------------------
// Leitura de CSV
// -----------------------------------------------------------------------------
// O relatório real vem em LATIN-1, com CRLF, separado por ponto e vírgula, e
// tem campo com ponto e vírgula DENTRO das aspas (a coluna E-mail traz dois
// endereços separados por `;`). Ler com split(";") corta a linha no meio e
// joga metade do arquivo fora — foi o que aconteceu na primeira passada do
// arquivo de 28/09/2026.
export function decodificar(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  // U+FFFD é o que o decodificador põe no lugar de byte que não é UTF-8.
  return utf8.includes("\uFFFD") ? new TextDecoder("latin1").decode(buffer) : utf8;
}

export function lerCsv(texto, separador = ";") {
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; continue; }
    if (c === separador) { linha.push(campo.trim()); campo = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo.trim()); campo = "";
      if (linha.some((x) => x !== "")) linhas.push(linha);
      linha = [];
      continue;
    }
    campo += c;
  }
  linha.push(campo.trim());
  if (linha.some((x) => x !== "")) linhas.push(linha);
  return linhas;
}

// -----------------------------------------------------------------------------
// Conversões
// -----------------------------------------------------------------------------
export function paraNumero(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let t = String(v).replace(/R\$/gi, "").replace(/\s/g, "").trim();
  if (!t) return null;
  const temVirgula = t.includes(","), temPonto = t.includes(".");
  if (temVirgula && temPonto) t = t.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) t = t.replace(",", ".");
  const n = Number(t);
  return isFinite(n) ? n : null;
}

export function paraDataISO(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let a = m[3]; if (a.length === 2) a = "20" + a;
    return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// Uma linha do arquivo vira o registro que a RPC espera. Só normaliza forma —
// quem decide o que é aceito é o banco, e a prévia usa a MESMA função que a
// confirmação para que as duas nunca discordem.
//
// TODO CAMPO DE `CAMPOS` PRECISA SAIR DAQUI. Já falhou uma vez: `Vcto Origem`
// e `Saldo Atualizado` eram reconhecidos no mapeamento e descartados aqui,
// silenciosamente. Sem `vencimento_origem`, a chave do título vira
// "<Dt Vcto>|" para todo mundo, e dois títulos do mesmo aluno com o mesmo
// vencimento atual colidem: no arquivo de 28/09/2026 isso apagava 5 títulos e
// R$ 10.541,67. O teste `preventivo_importacao_ponta_a_ponta.test.js` percorre
// `CAMPOS` e reprova se algum campo mapeado não chegar ao payload.
export function linhaParaRegistro(linha, mapa) {
  const pega = (id) => (mapa?.[id] === undefined ? null : linha[mapa[id]]);
  const texto = (id) => {
    const v = pega(id);
    return v === null || v === undefined ? null : String(v).trim() || null;
  };
  const numeroTexto = (id) => {
    const n = paraNumero(pega(id));
    return n === null ? null : String(n);
  };
  return {
    matricula: texto("matricula"),
    aluno_nome: texto("aluno_nome"),
    documento: texto("documento"),
    cpf: texto("cpf"),
    competencia: texto("competencia"),
    unidade: texto("unidade"),
    contrato: texto("contrato"),
    situacao: texto("situacao"),
    vencimento: paraDataISO(pega("vencimento")),
    vencimento_origem: paraDataISO(pega("vencimento_origem")),
    valor: numeroTexto("valor"),
    saldo: numeroTexto("saldo"),
    saldo_atualizado: numeroTexto("saldo_atualizado"),
    celular: texto("celular"),
    email: texto("email"),
  };
}

// A ponte entre `CAMPOS` (o que a tela mapeia) e o payload (o que a RPC
// recebe). Existe para ser percorrida por teste: campo mapeado que não esteja
// aqui é campo que se perde no caminho.
export const CAMPO_NO_PAYLOAD = {
  matricula: "matricula",
  aluno_nome: "aluno_nome",
  documento: "documento",
  cpf: "cpf",
  competencia: "competencia",
  unidade: "unidade",
  contrato: "contrato",
  situacao: "situacao",
  vencimento: "vencimento",
  vencimento_origem: "vencimento_origem",
  valor: "valor",
  saldo: "saldo",
  saldo_atualizado: "saldo_atualizado",
  celular: "celular",
  email: "email",
};

// -----------------------------------------------------------------------------
// Arquivos para a mensageria
// -----------------------------------------------------------------------------
// FORMATO NÃO CONFERIDO COM A MENSAGERIA. Este é um CSV genérico, com cabeçalho
// em português e o celular já em 55+DDD+número. Antes de usar em produção é
// preciso o modelo de importação do CRM de mensageria — ver
// docs/preventivo/README.md, "O que falta".
export function csv(linhas, colunas) {
  const escapa = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = colunas.map((c) => escapa(c.rotulo)).join(";");
  const corpo = (linhas ?? []).map((l) => colunas.map((c) => escapa(c.valor(l))).join(";"));
  return [cab, ...corpo].join("\r\n");
}

export const COLUNAS_WHATSAPP = [
  { rotulo: "nome", valor: (l) => l.aluno },
  { rotulo: "telefone", valor: (l) => l.contato },
  { rotulo: "matricula", valor: (l) => l.matricula },
  { rotulo: "vencimento", valor: (l) => l.vencimento },
  { rotulo: "valor", valor: (l) => l.saldo_informado },
];

export const COLUNAS_EMAIL = [
  { rotulo: "nome", valor: (l) => l.aluno },
  { rotulo: "email", valor: (l) => l.contato },
  { rotulo: "matricula", valor: (l) => l.matricula },
  { rotulo: "vencimento", valor: (l) => l.vencimento },
  { rotulo: "valor", valor: (l) => l.saldo_informado },
];

export const COLUNAS_SEPARADOS = [
  { rotulo: "nome", valor: (l) => l.aluno },
  { rotulo: "matricula", valor: (l) => l.matricula },
  { rotulo: "vencimento", valor: (l) => l.vencimento },
  { rotulo: "contato", valor: (l) => l.contato },
  { rotulo: "motivo", valor: (l) => l.motivo },
];

// -----------------------------------------------------------------------------
// Leitura da situação da sincronização, para a tela nunca dizer "conferido"
// quando não está.
// -----------------------------------------------------------------------------
export function frescorDaAtualizacao(situacao, agora = new Date()) {
  const ultima = situacao?.ultima_completa?.concluido_em;
  if (!ultima) {
    return { nivel: "nunca", texto: "Esta carteira ainda não foi atualizada com o Prime." };
  }
  const horas = (agora - new Date(ultima)) / 36e5;
  if (horas > 36) {
    return { nivel: "desatualizado", horas,
      texto: "A última atualização completa tem mais de 36 horas. A lista pode não refletir pagamentos recentes." };
  }
  return { nivel: "atual", horas, texto: "Atualizado com o Prime." };
}
