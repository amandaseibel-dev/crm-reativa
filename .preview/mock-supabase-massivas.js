// Supabase inerte para ver o painel "Registro das ações massivas": sem rede,
// sem banco, sem login. O COMPONENTE é o real (src/pages/AcoesMassivas.jsx).
//
// Os 4 lotes abaixo cobrem os estados que o painel precisa distinguir, com
// números copiados de lotes verdadeiros de produção para o texto não mentir:
//   * registrado inteiro, no clique de Exportar (o lote de 19/10 16:54);
//   * registrado em parte, com o motivo guardado (o de 01/10, que ela
//     confirmou 4 dias depois e perdeu 219 para "já acionados");
//   * pendente (o fluxo antigo, hoje raro — é quando o botão aparece);
//   * descartado (o de 21/09, que nunca registrou nada).

const horasAtras = (h) => new Date(Date.now() - h * 3600000).toISOString();

const LOTES_REGISTRO = [
  {
    id: "30d3dd32-9864-44a7-91aa-38a2e55b2d16",
    canal: "WHATSAPP",
    arquivo: "acao-massiva-whatsapp-sem-responsavel-mensalidades-2026-10-19.xlsx",
    tipo_cobranca: "MENSALIDADES",
    operador_email: null,
    operador_nome: null,
    total: 300,
    registrados: 300,
    registrados_efetivos: 300,
    registro_automatico: true,
    exportado_em: horasAtras(1),
    exportado_por_email: "amanda.seibel@aelbra.com.br",
    confirmado_em: horasAtras(1),
    confirmado_por_email: "amanda.seibel@aelbra.com.br",
    descartado_em: null,
    situacao: "REGISTRADO",
    excluidos: {},
    excluidos_por_motivo: {},
  },
  {
    id: "32bf549c-e656-46ed-b14c-1d9f58c477ba",
    canal: "WHATSAPP",
    arquivo: "acao-massiva-whatsapp-mensalidades-e-acordos-2026-10-01.xlsx",
    tipo_cobranca: "MENSALIDADES_E_ACORDOS",
    operador_email: "cobranca05@aelbra.com.br",
    operador_nome: "Jeferson",
    total: 300,
    registrados: 81,
    registrados_efetivos: 81,
    registro_automatico: false,
    exportado_em: horasAtras(30),
    exportado_por_email: "amanda.seibel@aelbra.com.br",
    confirmado_em: horasAtras(26),
    confirmado_por_email: "amanda.seibel@aelbra.com.br",
    descartado_em: null,
    situacao: "REGISTRADO",
    excluidos: { acionados_apos_exportacao: 219 },
    excluidos_por_motivo: {},
  },
  {
    id: "aaaa1111-0000-4000-8000-000000000001",
    canal: "EMAIL",
    arquivo: "acao-massiva-email-acordos-vencidos-2026-10-18.xlsx",
    tipo_cobranca: "ACORDOS_VENCIDOS",
    operador_email: "cobranca12@aelbra.com.br",
    operador_nome: "Tatiane",
    total: 142,
    registrados: null,
    registrados_efetivos: null,
    registro_automatico: false,
    exportado_em: horasAtras(20),
    exportado_por_email: "cobranca12@aelbra.com.br",
    confirmado_em: null,
    confirmado_por_email: null,
    descartado_em: null,
    situacao: "PENDENTE",
    excluidos: {},
    excluidos_por_motivo: {},
  },
  {
    id: "d6128b02-1c8b-46c1-88bd-12ea9fb3d3d4",
    canal: "WHATSAPP",
    arquivo: "acao-massiva-whatsapp-mensalidades-e-acordos-2026-09-21.xlsx",
    tipo_cobranca: "MENSALIDADES_E_ACORDOS",
    operador_email: null,
    operador_nome: null,
    total: 1000,
    registrados: null,
    registrados_efetivos: null,
    registro_automatico: false,
    exportado_em: horasAtras(48),
    exportado_por_email: "amanda.seibel@aelbra.com.br",
    confirmado_em: null,
    confirmado_por_email: null,
    descartado_em: horasAtras(47),
    situacao: "DESCARTADO",
    excluidos: {},
    excluidos_por_motivo: {},
  },
];

// Estado do preview: confirmar/descartar o pendente muda a linha na hora, como
// em produção (a tela recarrega a lista depois de concluir o lote).
const estado = { lotes: LOTES_REGISTRO.map((l) => ({ ...l })) };

const RESPOSTAS = {
  acoes_massivas_lotes_registro: () => estado.lotes,
  acoes_massivas_lotes_pendentes: () => estado.lotes.filter((l) => l.situacao === "PENDENTE"),
  acoes_massivas_lotes_whatsapp: () => [],
  acoes_massivas_filtros: () => ({ unidades: ["CANOAS", "GRAVATAI"], cursos: [], situacoes_academicas: [], operadores: [] }),
  acoes_massivas_responsaveis: () => [],
  acoes_massivas_borderos: () => [],
  acoes_massivas_por_dia: () => [],
  acoes_massivas_retornos: () => [],
  saude_da_base: () => null,
  acoes_massivas_concluir_lote: (args) => {
    const lote = estado.lotes.find((l) => l.id === args?.p_lote_id);
    if (!lote) return { lote_id: args?.p_lote_id, registrados: 0 };
    // Lote JÁ registrado: a função de verdade devolve o resultado guardado e
    // sai antes de qualquer escrita. O preview imita exatamente isso.
    if (lote.situacao === "REGISTRADO") {
      return {
        lote_id: lote.id,
        ja_registrado: true,
        registrados: lote.registrados_efetivos ?? lote.registrados ?? 0,
        movimentacoes_criadas: 0,
      };
    }
    if (args?.p_acao === "DESCARTAR") {
      lote.situacao = "DESCARTADO";
      lote.descartado_em = new Date().toISOString();
      return { lote_id: lote.id, descartado: true, registrados: 0 };
    }
    lote.situacao = "REGISTRADO";
    lote.confirmado_em = new Date().toISOString();
    lote.registrados = lote.total - 3;
    lote.registrados_efetivos = lote.total - 3;
    lote.excluidos = { acionados_apos_exportacao: 3 };
    return {
      lote_id: lote.id,
      registrados: lote.registrados,
      movimentacoes_criadas: lote.registrados,
      excluidos_acionados_apos_exportacao: 3,
      excluidos_por_motivo: {},
    };
  },
};

export const supabase = {
  async rpc(nome, args) {
    const resposta = RESPOSTAS[nome];
    if (!resposta) return { data: null, error: null };
    return { data: resposta(args), error: null };
  },
  from() {
    const encadeia = {
      select: () => encadeia,
      eq: () => encadeia,
      in: () => encadeia,
      order: () => encadeia,
      limit: () => encadeia,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (ok) => ok({ data: [], error: null }),
    };
    return encadeia;
  },
  auth: {
    getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
};

export default supabase;
