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
    apelidos: ["matricula", "matrícula", "registration", "registro", "codigo do aluno", "código do aluno", "ra"] },
  { id: "aluno_nome",  rotulo: "Nome do aluno", obrigatorio: true,
    apelidos: ["nome", "aluno", "nome do aluno", "nome aluno", "cliente", "sacado"] },
  { id: "documento",   rotulo: "Identificador do título (boleto / documento)", obrigatorio: true,
    apelidos: ["boleto", "documento", "nosso numero", "nosso número", "titulo", "título", "numero do titulo", "número do título", "documentnumber"] },
  { id: "vencimento",  rotulo: "Vencimento", obrigatorio: true,
    apelidos: ["vencimento", "data de vencimento", "duedate", "venc"] },
  { id: "valor",       rotulo: "Valor do título", obrigatorio: true,
    apelidos: ["valor", "valor do titulo", "valor do título", "valor original", "netamount", "valor nominal"] },
  { id: "saldo",       rotulo: "Saldo em aberto", obrigatorio: false,
    apelidos: ["saldo", "saldo em aberto", "valor em aberto", "em aberto", "saldo devedor"] },
  { id: "competencia", rotulo: "Competência", obrigatorio: false,
    apelidos: ["competencia", "competência", "referencia", "referência", "semestre", "parcela"] },
  { id: "situacao",    rotulo: "Situação financeira", obrigatorio: false,
    apelidos: ["situacao", "situação", "status", "situacao financeira", "situação financeira"] },
  { id: "cpf",         rotulo: "CPF", obrigatorio: false,
    apelidos: ["cpf", "documento do aluno"] },
  { id: "celular",     rotulo: "Celular", obrigatorio: false,
    apelidos: ["celular", "telefone", "fone", "whatsapp", "telefone celular", "contato"] },
  { id: "email",       rotulo: "E-mail", obrigatorio: false,
    apelidos: ["email", "e-mail", "correio eletronico", "correio eletrônico"] },
  { id: "unidade",     rotulo: "Unidade", obrigatorio: false,
    apelidos: ["unidade", "campus", "establishment", "polo", "pólo"] },
  { id: "contrato",    rotulo: "Contrato", obrigatorio: false,
    apelidos: ["contrato", "numero do contrato", "número do contrato"] },
];

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const chave = (s) => semAcento(s).toLowerCase().replace(/\s+/g, " ").trim();

// Sugestão de mapeamento, nunca imposição: a tela mostra o que adivinhou e a
// gestão troca antes da prévia.
export function sugerirMapeamento(cabecalho) {
  const cols = (cabecalho ?? []).map((c, i) => ({ i, k: chave(c) }));
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
export function linhaParaRegistro(linha, mapa) {
  const pega = (id) => (mapa?.[id] === undefined ? null : linha[mapa[id]]);
  const texto = (id) => {
    const v = pega(id);
    return v === null || v === undefined ? null : String(v).trim() || null;
  };
  const valor = paraNumero(pega("valor"));
  const saldo = paraNumero(pega("saldo"));
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
    valor: valor === null ? null : String(valor),
    saldo: saldo === null ? null : String(saldo),
    celular: texto("celular"),
    email: texto("email"),
  };
}

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
  { rotulo: "valor", valor: (l) => l.saldo_atual ?? l.valor_inicial },
];

export const COLUNAS_EMAIL = [
  { rotulo: "nome", valor: (l) => l.aluno },
  { rotulo: "email", valor: (l) => l.contato },
  { rotulo: "matricula", valor: (l) => l.matricula },
  { rotulo: "vencimento", valor: (l) => l.vencimento },
  { rotulo: "valor", valor: (l) => l.saldo_atual ?? l.valor_inicial },
];

export const COLUNAS_SEPARADOS = [
  { rotulo: "nome", valor: (l) => l.aluno },
  { rotulo: "matricula", valor: (l) => l.matricula },
  { rotulo: "documento", valor: (l) => l.documento },
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
