// Supabase inerte para a revisão visual da Efetividade: sem rede, sem login.
//
// O COMPONENTE é o real (src/pages/CarteiraEfetividade.jsx +
// src/components/EfetividadePorVencimento.jsx). O que está trocado é só a
// camada de serviço.
//
// TUDO O QUE ESTÁ VERSIONADO AQUI É SINTÉTICO. Nada de produção entra neste
// arquivo nem em `dados-efetividade.js`: sem valor real, sem CPF, sem nome,
// sem id, sem contagem real de aluno ou título.
//
// Para conferir a tela com os números reais, crie `.preview/dados-efetividade
// .local.js` (ignorado pelo Git) exportando `payload` e, se quiser, também
// `negociacoes` e `contexto`. O preview prefere esse arquivo quando ele existe
// e diz na barra do topo que está usando dado real.
import { payload as sintetico } from "./dados-efetividade.js";

// import.meta.glob resolve em tempo de build e devolve {} quando o arquivo não
// existe — é o que permite o arquivo local ser opcional sem quebrar quem não o
// tem. Um import estático daria erro de módulo ausente.
const locais = import.meta.glob("./dados-efetividade.local.js", { eager: true });
const local = Object.values(locais)[0] || null;

export const usandoDadoReal = Boolean(local?.payload);

const POR_VENCIMENTO = local?.payload || sintetico;

// Números inventados, coerentes entre si, só para a tela ter o que desenhar
// fora da seção que esta entrega construiu.
const NEGOCIACOES = local?.negociacoes || {
  gerado_em: "2026-09-29T12:00:00+00:00",
  total: { cpfs: 10, acordos: 11, titulos: 12, negociado: 16000, recebido: 9000, saldo: 7000,
           titulos_por_fallback: 1, valor_por_fallback: 500 },
  estados: [
    { estado: "Quitado",          cpfs: 4, acordos: 4, titulos: 4, negociado: 6000, recebido: 6000, saldo: 0 },
    { estado: "Regular",          cpfs: 3, acordos: 3, titulos: 4, negociado: 5000, recebido: 2000, saldo: 3000 },
    { estado: "Em atraso",        cpfs: 2, acordos: 2, titulos: 2, negociado: 3000, recebido: 1000, saldo: 2000 },
    { estado: "Acordo quebrado",  cpfs: 1, acordos: 1, titulos: 1, negociado: 1000, recebido: 0,    saldo: 1000 },
    { estado: "Acordo cancelado", cpfs: 1, acordos: 1, titulos: 1, negociado: 1000, recebido: 0,    saldo: 1000 },
  ],
};

const CONTEXTO = local?.contexto || {
  remessas: 4, carteira_cpfs: 118, carteira_titulos: 150, carteira_valor: 161000,
  primeira_remessa: "2026-07-06", ultima_remessa: "2026-09-09",
  atualizado_em: "2026-09-29T12:00:00+00:00",
};

// Só 2026/2 entra nesta entrega. As outras safras devolvem a forma vazia que a
// tela real já sabe tratar — de propósito: assim o preview mostra o "Sem dados
// para 2026/1" em vez de fingir números que esta entrega não mexeu.
const RESPOSTAS = {
  carteira_2026_2_por_vencimento: POR_VENCIMENTO,
  carteira_2026_2_negociacoes: NEGOCIACOES,
  carteira_2026_2_contexto: CONTEXTO,
  carteira_2026_1_indicadores: { vazio: true },
  carteira_2026_1_academico: null,
  carteira_saldo_historico_por_ano: { anos: [], sem_semestre: null, snapshot_gerado_em: null },
};

const usuario = { id: "preview", email: "amanda.seibel@aelbra.com.br" };

export const supabase = {
  auth: {
    getUser: async () => ({ data: { user: usuario }, error: null }),
    getSession: async () => ({ data: { session: { user: usuario } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  // Objeto NOVO a cada chamada: devolver a mesma referência faria os useMemo da
  // tela nunca recalcularem, e apareceria um defeito que produção não tem.
  rpc: async (nome) => {
    if (!(nome in RESPOSTAS)) return { data: null, error: { message: "RPC sem dublê: " + nome } };
    return { data: structuredClone(RESPOSTAS[nome]), error: null };
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
};
