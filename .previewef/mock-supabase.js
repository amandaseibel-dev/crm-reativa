import { painel, detalhe } from "./dados.js";

// O cenario e lido a CADA chamada: o botao da barra troca o valor e remonta a
// tela, e a RPC precisa responder com o estado novo.
export const cenario = { comTabulacao: false };

// Guarda o que foi "conferido" no preview, para a segunda leitura refletir.
const conferidos = new Map();

export const supabase = {
  async rpc(nome, args) {
    await new Promise((r) => setTimeout(r, 120));
    if (nome === "carteira_2026_2_competencias") {
      return { data: painel(cenario.comTabulacao), error: null };
    }
    if (nome === "carteira_2026_2_competencia_detalhe") {
      const d = detalhe(args?.p_indicador, true);
      for (const l of d.linhas) {
        const c = conferidos.get(l.titulo_id);
        if (c) { l.conferido_por = c.por; l.conferido_em = c.em; }
      }
      return { data: d, error: null };
    }
    if (nome === "carteira_conferir_em_aberto") {
      // Dubla a regra 6: se o estado enviado nao bate com o "banco", recusa.
      if (args?.p_situacao_vista !== "ABERTO") {
        return { data: null, error: { message:
          "ESTADO_MUDOU: o titulo mudou desde que a tela carregou. Recarregue e confira de novo." } };
      }
      const por = "gestao@reativa.local";
      conferidos.set(args.p_titulo_id, { por, em: new Date().toISOString() });
      return { data: { ok: true, titulo_id: args.p_titulo_id, conferido_por: por }, error: null };
    }
    return { data: null, error: { message: "RPC sem duble no preview: " + nome } };
  },
};
export default supabase;
