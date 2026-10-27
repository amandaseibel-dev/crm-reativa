// Criticas da importacao de acordos: rotulos, ordem e exportacao.
//
// Separado da tela de proposito -- e a regra de LEITURA das criticas, e o que
// decide se a operacao olha ou ignora o painel. As tres classes tem pesos
// diferentes e nao podem aparecer como "erro" indistinto: duas delas sao o
// sistema funcionando.

export const CLASSES = {
  REJEICAO: {
    rotulo: "Rejeitada",
    descricao: "A linha nao pode ser lida. Alguem precisa olhar o arquivo.",
    tom: "vermelho",
    ordem: 1,
  },
  DUPLICIDADE: {
    rotulo: "Duplicidade",
    descricao: "A linha ja esta representada por um registro igual no CRM.",
    tom: "amarelo",
    ordem: 2,
  },
  IGNORADA_POR_REGRA: {
    rotulo: "Ignorada por regra",
    descricao: "Deixada de fora por uma regra que ja existia. Nao e erro.",
    tom: "azul",
    ordem: 3,
  },
};

export const MOTIVOS = {
  documento_invalido: "Documento invalido ou ausente na linha",
  titulo_ja_existe: "Titulo com este documento ja existe",
  acordo_duplicado_sinalizado: "Acordo sinalizado como duplicado",
  cpf_quitado_recente: "CPF quitado nos ultimos 7 dias, com acordo",
  divida_ja_representada: "Divida ja representada por parcela ou acordo",
};

export function rotuloClasse(classe) {
  return CLASSES[classe]?.rotulo || classe || "-";
}

export function rotuloMotivo(motivo) {
  return MOTIVOS[motivo] || motivo || "-";
}

export function tomDaClasse(classe) {
  return CLASSES[classe]?.tom || "cinza";
}

// Resumo de `importacao_acordo_critica_resumo` -> uma linha por classe, na
// ordem de atencao (rejeicao primeiro), com os motivos que a compoem.
export function agruparResumo(linhas) {
  const porClasse = new Map();
  for (const l of linhas || []) {
    const atual = porClasse.get(l.classe) || { classe: l.classe, total: 0, motivos: [] };
    atual.total += Number(l.total) || 0;
    atual.motivos.push({ motivo_codigo: l.motivo_codigo, total: Number(l.total) || 0 });
    porClasse.set(l.classe, atual);
  }
  return [...porClasse.values()]
    .map((c) => ({ ...c, motivos: c.motivos.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => (CLASSES[a.classe]?.ordem || 99) - (CLASSES[b.classe]?.ordem || 99));
}

export function totalDeCriticas(linhas) {
  return (linhas || []).reduce((s, l) => s + (Number(l.total) || 0), 0);
}

// Uma importacao com critica NUNCA e "concluida" sem mais nada na tela.
export function temCritica(linhas) {
  return totalDeCriticas(linhas) > 0;
}

const CABECALHO = [
  "classe", "classe_rotulo", "motivo_codigo", "motivo_rotulo", "origem",
  "linha_numero", "documento", "acordo_ulbra", "cpf_mascarado", "nome",
  "vencimento", "valor", "detectado_em",
];

// CSV para conferencia. Prefixo apostrofo em campo que o Excel converteria
// (documento de 12 digitos vira notacao cientifica, e CPF mascarado com
// pontos vira data em algumas configuracoes).
function celula(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const precisaTexto = /^[0-9]{9,}$/.test(s);
  const bruto = precisaTexto ? "\t" + s : s;
  return /[";\n\r\t]/.test(bruto) ? '"' + bruto.replace(/"/g, '""') + '"' : bruto;
}

export function criticasParaCsv(linhas) {
  const corpo = (linhas || []).map((l) => [
    l.classe, rotuloClasse(l.classe), l.motivo_codigo, rotuloMotivo(l.motivo_codigo),
    l.origem, l.linha_numero, l.documento, l.acordo_ulbra, l.cpf_mascarado, l.nome,
    l.vencimento, l.valor, l.detectado_em,
  ].map(celula).join(";"));
  return [CABECALHO.join(";"), ...corpo].join("\r\n");
}

export function nomeDoCsv(importacaoId) {
  const id = String(importacaoId || "sem-lote").slice(0, 8);
  return `criticas-importacao-acordos-${id}.csv`;
}

// 23/10/2026: a trilha de criticas comeca aqui. Nenhuma das 136 importacoes
// anteriores registrou critica, e nenhuma foi reconstruida -- entao "0
// criticas" numa delas seria afirmar fato sem prova. A tela mostra "sem
// registro", que e ausencia de REGISTRO, nao ausencia de problema.
export const INICIO_DA_TRILHA = "2026-10-23T00:00:00Z";

export function semRegistroDeCritica(importadoEm) {
  if (!importadoEm) return true;
  const d = new Date(importadoEm);
  return isNaN(d) ? true : d < new Date(INICIO_DA_TRILHA);
}

// ---------------------------------------------------------------------------
// O resultado da importacao na tela.
//
// Exigencia da gestao em 23/10/2026: "nao considerar sucesso uma importacao
// parcial sem apresentar suas criticas". Estas duas funcoes sao o ponto onde
// isso e decidido -- ficam aqui, e nao dentro do JSX da tela, porque sao a
// regra e precisam de teste proprio.
// ---------------------------------------------------------------------------

export function tituloDoResultado(criticasTotal) {
  const n = Number(criticasTotal) || 0;
  if (n <= 0) return "Importacao concluida \u2705";
  return `Importação concluída com ${n.toLocaleString("pt-BR")} crítica${n > 1 ? "s" : ""}`;
}

// `null` = nao houve tentativa (nenhum arquivo em memoria para subir).
// `false` = tentou e nao ficou -- e o caso que a tela TEM de avisar, porque
// senao a importacao passa por auditavel sem ser.
export function avisoDeArquivo(arquivoPreservado) {
  if (arquivoPreservado === false) return "nao_preservado";
  if (arquivoPreservado === true) return "preservado";
  return "sem_tentativa";
}
