// PAINEL DE DIAGNÓSTICO DA INTEGRAÇÃO PRIME — parte pura
// =============================================================================
//
// Monta o caminho que vai para a Edge Function `prime-sonda`, decide se ele é
// aceitável ANTES de sair, e reduz a resposta a CONTAGENS. Nada aqui fala com a
// rede: a tela (`src/pages/DiagnosticoPrime.jsx`) é que invoca a função, e o
// faz pelo cliente Supabase do próprio app — nenhum token é lido, copiado ou
// montado à mão em lugar nenhum desta entrega.
//
// POR QUE O AGREGADO É O PADRÃO, e não a resposta.
// A `prime-sonda` sem `cru` devolve a FORMA da resposta — e a função `forma()`
// dela (supabase/functions/prime-sonda/index.ts) devolve o VALOR de todo
// escalar curto, truncado em 60 caracteres. Ou seja: `forma` carrega nome e
// CPF. Despejar `forma` na página seria expor dado pessoal achando que se está
// mostrando estrutura. Por isso esta camada só produz:
//
//   - contagens (itens, por `carrier.id`, `isAgreementInstallment === true`);
//   - NOMES de campo (do primeiro item e das chaves de topo);
//   - o tamanho e o status que a própria sonda informa.
//
// Nome de campo e contagem não identificam ninguém. Valor identifica.
//
// E O CONTEÚDO CHEGA AO NAVEGADOR DE TODO JEITO — isto precisa estar escrito.
// Contar por portador e comparar duas respostas exige o conteúdo inteiro, então
// a tela pede `cru: true` e agrega aqui, na memória. A proteção é de
// APRESENTAÇÃO: a tela não exibe o conteúdo sem que alguém ligue um botão com
// aviso. Quem abre o painel é gestão, com sessão própria, consultando a API que
// a gestão já pode consultar — o que esta camada impede é o dado pessoal
// aparecer na tela (e em print, e em gravação de reunião) sem ninguém pedir.
//
// FONTE OFICIAL: docs/integracoes/ (regra do CLAUDE.md). O que esta tela vai
// conferir já está documentado em `prime-api.md`:
//   - `financial_statement`: "`carrierId` é IGNORADO neste endpoint — resposta
//     idêntica com ou sem ele (medido)";
//   - `agreements`: devolveu `{items: [], totalItems: 0}` em todos os testes,
//     inclusive para acordo ATIVO na tela do Prime no mesmo instante;
//   - carrier 166 nunca apareceu numa linha de extrato (67 alunos/1.625 linhas).
// A tela existe para a gestão RECONFERIR isso com a própria sessão. Se o
// resultado divergir do documentado, a regra do README manda atualizar
// `prime-api.md` + `prime-api-catalog.json` + `prime-mapa-fontes-verdade.md` na
// mesma alteração — não é achado para ficar num chat.

// -----------------------------------------------------------------------------
// ESPELHO DA ALLOWLIST DO SERVIDOR
// -----------------------------------------------------------------------------
// Cópia fiel de `CAMINHOS_PERMITIDOS` de supabase/functions/prime-sonda/portao.ts.
//
// O PORTÃO DE VERDADE É O DO SERVIDOR. Esta lista aqui é CONVENIÊNCIA: serve
// para a tela não gastar uma chamada que voltaria 400, e para quem está olhando
// entender por que o caminho foi recusado. Ela não protege nada — qualquer um
// com a sessão pode chamar a função direto, e é `portao.ts` que decide. Se as
// duas divergirem, quem vale é o servidor; `primeSonda.test.js` compara os dois
// arquivos e quebra quando um muda sem o outro.
export const CAMINHOS_PERMITIDOS = [
  /^\/carriers(\?.*)?$/,
  /^\/students\?[^/]*$/,
  /^\/students\/[A-Za-z0-9._-]+$/,
  /^\/students\/[A-Za-z0-9._-]+\/contracts(\?.*)?$/,
  /^\/students\/[A-Za-z0-9._-]+\/financial-statement(\?.*)?$/,
  /^\/students\/[A-Za-z0-9._-]+\/agreements(\?.*)?$/,
];

export const PERMITIDOS_LEGIVEL = [
  "/carriers",
  "/students?search=...",
  "/students/{registration}",
  "/students/{registration}/contracts",
  "/students/{registration}/financial-statement",
  "/students/{registration}/agreements",
];

// Mesma lógica do servidor, incluindo a recusa de ".." e "//" antes de olhar a
// lista: barra dupla e volta de diretório sairiam do caminho pretendido mesmo
// casando com um padrão.
export function caminhoPermitido(caminho) {
  if (typeof caminho !== "string" || !caminho.startsWith("/")) return false;
  if (caminho.includes("..") || caminho.includes("//")) return false;
  return CAMINHOS_PERMITIDOS.some((re) => re.test(caminho));
}

// -----------------------------------------------------------------------------
// O SELETOR
// -----------------------------------------------------------------------------
// O caminho NÃO é campo de texto livre: a tela escolhe uma FORMA e preenche
// matrícula e query. As seis formas são as de `PERMITIDOS_LEGIVEL`, na mesma
// ordem — nenhuma rota nova é oferecida por aqui.
//
// `aceitaQuery: false` no composto não é capricho: o padrão do servidor é
// `^/students/{reg}$`, sem query nenhuma. A tela avisa, e se alguém insistir o
// caminho montado é recusado pela allowlist antes de sair — nada é descartado
// em silêncio.
export const FORMAS = [
  { chave: "carriers", rotulo: "/carriers", legenda: "portadores (sem dado de pessoa)", exigeMatricula: false, aceitaQuery: true, queryObrigatoria: false },
  { chave: "students_busca", rotulo: "/students?search=...", legenda: "busca de aluno — a query é obrigatória", exigeMatricula: false, aceitaQuery: true, queryObrigatoria: true },
  { chave: "student_composite", rotulo: "/students/{registration}", legenda: "composto: registrationData, contracts, financialStatement, agreements", exigeMatricula: true, aceitaQuery: false, queryObrigatoria: false },
  { chave: "student_contracts", rotulo: "/students/{registration}/contracts", legenda: "contratos por semestre", exigeMatricula: true, aceitaQuery: true, queryObrigatoria: false },
  { chave: "financial_statement", rotulo: "/students/{registration}/financial-statement", legenda: "extrato financeiro", exigeMatricula: true, aceitaQuery: true, queryObrigatoria: false },
  { chave: "agreements", rotulo: "/students/{registration}/agreements", legenda: "acordos do aluno", exigeMatricula: true, aceitaQuery: true, queryObrigatoria: false },
];

export function formaPorChave(chave) {
  return FORMAS.find((f) => f.chave === chave) || null;
}

function limpaMatricula(m) {
  return String(m ?? "").trim();
}

// Aceita tanto "carrierId=166" quanto "?carrierId=166" — quem copia da barra do
// navegador traz o "?".
function limpaQuery(q) {
  return String(q ?? "").trim().replace(/^\?+/, "");
}

// Monta o caminho e NÃO conserta nada: matrícula vazia vira "/students//…", que
// a allowlist recusa pela regra do "//", e query no composto vira
// "/students/123?take=1", que nenhum padrão aceita. A recusa visível é melhor
// que um caminho silenciosamente diferente do que a pessoa pediu.
export function montarCaminho({ forma, matricula, query } = {}) {
  const f = typeof forma === "string" ? formaPorChave(forma) : forma;
  if (!f) return "";
  const m = limpaMatricula(matricula);
  const q = limpaQuery(query);
  if (f.chave === "carriers") return q ? `/carriers?${q}` : "/carriers";
  // A busca de aluno SEMPRE leva o "?": o padrão do servidor é `^/students\?…`
  // e "/students" sem interrogação não casa com nada.
  if (f.chave === "students_busca") return `/students?${q}`;
  const base = `/students/${m}`;
  const sufixo = {
    student_composite: "",
    student_contracts: "/contracts",
    financial_statement: "/financial-statement",
    agreements: "/agreements",
  }[f.chave] ?? "";
  const semQuery = base + sufixo;
  return q ? `${semQuery}?${q}` : semQuery;
}

// Por que a tela recusa, em frase. Separado de `caminhoPermitido` porque o
// servidor não precisa explicar — a tela precisa.
export function motivoDaRecusa({ forma, matricula, query } = {}) {
  const f = typeof forma === "string" ? formaPorChave(forma) : forma;
  if (!f) return "escolha uma das formas de caminho";
  const m = limpaMatricula(matricula);
  const q = limpaQuery(query);
  if (f.exigeMatricula && !m) return "informe a matrícula (registration) do aluno";
  if (f.exigeMatricula && !/^[A-Za-z0-9._-]+$/.test(m)) {
    return "a matrícula só pode ter letras, números, ponto, hífen e sublinhado";
  }
  if (f.queryObrigatoria && !q) return "esta forma exige query string (ex.: search=nome)";
  if (!f.aceitaQuery && q) return "esta forma não aceita query string — o portão do servidor recusa";
  const caminho = montarCaminho({ forma: f, matricula: m, query: q });
  if (!caminhoPermitido(caminho)) return `fora da lista de caminhos permitidos: ${caminho}`;
  return "";
}

// -----------------------------------------------------------------------------
// OS QUATRO TESTES DA GESTÃO
// -----------------------------------------------------------------------------
// O portador 166 é o convênio de acordo da ULBRA. A pergunta que a tela existe
// para responder: o extrato é FILTRADO por escopo de portador? Se 1 e 2
// devolverem coisas diferentes, existe caminho de automação para acordo; se
// devolverem o mesmo, `prime-api.md` continua certo e o filtro é ignorado.
export const CARRIER_DO_ACORDO = 166;

export function osQuatroCaminhos(matricula) {
  const m = limpaMatricula(matricula);
  return [
    { chave: "t1", rotulo: "1 · extrato sem parâmetro", caminho: montarCaminho({ forma: "financial_statement", matricula: m }) },
    { chave: "t2", rotulo: `2 · extrato com carrierId=${CARRIER_DO_ACORDO}`, caminho: montarCaminho({ forma: "financial_statement", matricula: m, query: `carrierId=${CARRIER_DO_ACORDO}` }) },
    { chave: "t3", rotulo: "3 · agreements", caminho: montarCaminho({ forma: "agreements", matricula: m }) },
    { chave: "t4", rotulo: "4 · composto (campo agreements)", caminho: montarCaminho({ forma: "student_composite", matricula: m }) },
  ];
}

// -----------------------------------------------------------------------------
// O AGREGADO
// -----------------------------------------------------------------------------
function listaDeItens(corpo) {
  if (Array.isArray(corpo)) return corpo;
  if (corpo && typeof corpo === "object" && Array.isArray(corpo.items)) return corpo.items;
  return null;
}

// `carrier` é instituição (REATIVA, ULBRA, convênio), não pessoa: id e nome de
// portador podem aparecer. É o que responde a pergunta do escopo.
function contarPorCarrier(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const c = it && typeof it === "object" ? it.carrier : null;
    const id = c && typeof c === "object" ? c.id : (c ?? null);
    const chave = id === null || id === undefined ? "sem carrier" : String(id);
    const atual = mapa.get(chave) || { id: chave, nome: null, n: 0 };
    if (!atual.nome && c && typeof c === "object" && c.name) atual.nome = String(c.name);
    atual.n += 1;
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => b.n - a.n || String(a.id).localeCompare(String(b.id)));
}

function nomesDeCampo(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  return Object.keys(item);
}

function agregarLista(itens) {
  return {
    itens: itens.length,
    porCarrier: contarPorCarrier(itens),
    parcelaDeAcordo: itens.filter((it) => it && it.isAgreementInstallment === true).length,
    campos: nomesDeCampo(itens[0]),
  };
}

// Reduz o corpo da resposta da Prime a contagens e nomes de campo. NUNCA
// devolve valor de campo de item: nem amostra, nem primeiro valor, nem
// truncado.
export function agregarCorpo(corpo) {
  const base = { itens: null, totalItens: null, porCarrier: [], parcelaDeAcordo: 0, campos: [], chavesDeTopo: [], blocos: [] };
  if (corpo === null || corpo === undefined) return base;
  if (typeof corpo === "string") return { ...base, textoNaoJson: true };
  const lista = listaDeItens(corpo);
  if (lista) {
    const totalItens = corpo && typeof corpo === "object" && !Array.isArray(corpo) && Number.isFinite(corpo.totalItems)
      ? corpo.totalItems : null;
    return { ...base, ...agregarLista(lista), totalItens };
  }
  if (typeof corpo !== "object") return base;
  // Composto: cada chave de topo é um bloco, e `agreements` vazio dentro dele é
  // justamente o que o teste 4 quer ver.
  const chavesDeTopo = Object.keys(corpo);
  const blocos = chavesDeTopo.map((chave) => {
    const valor = corpo[chave];
    const sub = listaDeItens(valor);
    if (sub) return { chave, ...agregarLista(sub), totalItens: Number.isFinite(valor?.totalItems) ? valor.totalItems : null };
    return {
      chave,
      itens: null,
      totalItens: null,
      porCarrier: [],
      parcelaDeAcordo: 0,
      campos: valor && typeof valor === "object" && !Array.isArray(valor) ? Object.keys(valor) : [],
    };
  });
  return { ...base, chavesDeTopo, blocos };
}

// Agregado da resposta INTEIRA da sonda: o que ela informa sobre a chamada
// (status da Prime, tipo, tamanho) mais o agregado do conteúdo.
export function agregarResposta(resposta) {
  const r = resposta && typeof resposta === "object" ? resposta : {};
  return {
    caminho: typeof r.caminho === "string" ? r.caminho : null,
    statusPrime: Number.isFinite(r.status) ? r.status : null,
    tipo: typeof r.tipo === "string" ? r.tipo : null,
    tamanho: Number.isFinite(r.tamanho) ? r.tamanho : null,
    // `forma` é DE PROPÓSITO ignorada: ela traz valor de escalar curto (nome,
    // CPF). O agregado sai do `cru`, que a tela pede e não exibe.
    ...agregarCorpo(r.cru ?? null),
    temCru: r.cru !== undefined && r.cru !== null,
  };
}

// -----------------------------------------------------------------------------
// A COMPARAÇÃO — o objetivo da tela
// -----------------------------------------------------------------------------
// JSON com chaves ordenadas, recursivamente. A string resultante CONTÉM dado
// pessoal, então vive só dentro desta função: entra o corpo, sai um booleano.
function canonico(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  const chaves = Object.keys(v).sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(",")}}`;
}

// `null` = não se sabe (alguma das duas não respondeu). Nunca "sim" por
// omissão: duas falhas não são duas respostas iguais.
export function respostasIdenticas(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return canonico(a) === canonico(b);
}

// Em que as duas diferem, dito só por contagem — nada de valor.
export function diferencasDeAgregado(ag1, ag2) {
  if (!ag1 || !ag2) return [];
  const fora = [];
  if (ag1.itens !== ag2.itens) fora.push(`itens: ${ag1.itens ?? "—"} × ${ag2.itens ?? "—"}`);
  if (ag1.totalItens !== ag2.totalItens) fora.push(`totalItems: ${ag1.totalItens ?? "—"} × ${ag2.totalItens ?? "—"}`);
  if (ag1.tamanho !== ag2.tamanho) fora.push(`tamanho: ${ag1.tamanho ?? "—"} × ${ag2.tamanho ?? "—"} bytes`);
  if (ag1.parcelaDeAcordo !== ag2.parcelaDeAcordo) {
    fora.push(`isAgreementInstallment=true: ${ag1.parcelaDeAcordo} × ${ag2.parcelaDeAcordo}`);
  }
  const porId = (ag) => new Map(ag.porCarrier.map((c) => [String(c.id), c.n]));
  const m1 = porId(ag1); const m2 = porId(ag2);
  for (const id of new Set([...m1.keys(), ...m2.keys()])) {
    if (m1.get(id) !== m2.get(id)) fora.push(`portador ${id}: ${m1.get(id) ?? 0} × ${m2.get(id) ?? 0}`);
  }
  return fora;
}
