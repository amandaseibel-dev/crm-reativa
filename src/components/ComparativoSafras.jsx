import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, moeda } from "./situacoesDaSafraFormato";

// COMPARATIVO ENTRE SAFRAS — compacto, de proposito.
//
// Cinco colunas e nada mais: Safra, Universo recebido, Recuperado, Em aberto e
// Efetividade. O objetivo e comparacao executiva — "em qual safra a cobranca
// rende mais?" — e nao repetir a analise da safra selecionada. A composicao
// academica, as pendencias por motivo e as seis linhas detalhadas aparecem UMA
// vez cada, no recorte que a pessoa escolheu acima.
//
// SUBSTITUIU o card "Status academico por safra", que comparava as tres safras
// repetindo categoria por categoria a mesma lista acadêmica que a composicao do
// saldo ja desenha para a safra selecionada. Comparar as tres safras continua
// valendo; comparar a composicao academica inteira das tres, nao.
//
// REAPROVEITA `carteira_safra_situacoes`, a MESMA RPC do resumo da carteira e
// das seis linhas — tres chamadas, uma por safra. Nenhuma RPC nova foi criada
// para este bloco, e por vir da mesma fonte a linha da safra selecionada e
// identica, ao centavo, ao resumo do topo da pagina.
//
// 2026/2 FICA FORA. Aquele semestre esta em curso e nao tem inadimplencia por
// desenho (ha titulo a vencer): nao existe "em aberto" nem efetividade
// comparavel, e forcar a linha seria inventar regua.
//
// Nenhuma conta aqui alem do share de Pago sobre Entrou — a mesma participacao
// que as seis linhas ja desenham na barra da linha "Pago".

const SAFRAS = [
  { chave: "2024",   ano: "2024", semestre: null, rotulo: "2024" },
  { chave: "2025",   ano: "2025", semestre: null, rotulo: "2025" },
  { chave: "2026/1", ano: "2026", semestre: "1",  rotulo: "2026/1" },
];

const pct = (parte, todo) =>
  Number(todo) > 0
    ? ((100 * Number(parte)) / Number(todo)).toLocaleString("pt-BR",
        { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%"
    : "—";

export default function ComparativoSafras({ selecionada = null, recarga = 0 }) {
  const [linhas, setLinhas] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const rs = await Promise.all(
        SAFRAS.map((s) => supabase.rpc("carteira_safra_situacoes",
          { p_ano: s.ano, p_semestre: s.semestre })));
      if (!ativo) return;
      const falhou = rs.find((r) => r.error);
      if (falhou) { setErro(falhou.error.message || "falha ao consultar"); setCarregando(false); return; }
      setLinhas(SAFRAS.map((s, i) => {
        const sit = rs[i].data?.situacoes || {};
        return {
          ...s,
          entrou: Number(sit.entrou?.valor || 0),
          pago: Number(sit.pago?.valor || 0),
          em_aberto: Number(sit.em_aberto?.valor || 0),
          alunos: Number(sit.entrou?.alunos || 0),
          titulos: Number(sit.entrou?.titulos || 0),
        };
      }));
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [recarga]);

  if (carregando) return <p style={S.discreto}>Comparando as safras…</p>;
  if (erro) {
    return (
      <p style={S.erro}>
        Não foi possível comparar as safras: {erro}. Os números da safra selecionada não dependem desta
        consulta e seguem válidos.
      </p>
    );
  }
  if (!linhas) return null;

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Comparativo entre safras</h2>
        <span style={S.apoio}>2024, 2025 e 2026/1 · leitura executiva</span>
      </div>

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Safra</th>
              <th style={E.th}>Universo recebido</th>
              <th style={E.th}>Recuperado</th>
              <th style={E.th}>Em aberto</th>
              <th style={E.th}>Efetividade</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const aqui = selecionada === l.chave;
              return (
                <tr key={l.chave} style={aqui ? E.trAtual : null}>
                  <td style={E.tdSafra}>
                    {l.rotulo}
                    {aqui ? <span style={E.selo}>em análise acima</span> : null}
                  </td>
                  <td style={E.tdValor}>{moeda(l.entrou)}</td>
                  <td style={E.tdValor}>{moeda(l.pago)}</td>
                  <td style={E.tdValor}>{moeda(l.em_aberto)}</td>
                  <td style={E.tdPct}>{pct(l.pago, l.entrou)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Nenhuma coluna se soma entre safras.</strong> Existem CPFs sobrepostos entre períodos — o
        mesmo aluno pode ter mensalidade em 2024 e em 2025 —, então somar alunos de safras diferentes
        contaria pessoas duas vezes. Cada linha é fechada em si.
      </p>
      <p style={S.rodape}>
        Em 2024 e 2025 o universo é o <strong>saldo residual</strong> que ainda estava aberto quando a
        carteira entrou em cobrança, não a carteira que a instituição emitiu no ano — o CRM não guarda nada
        anterior a julho/2026. 2026/2 fica fora: o semestre está em curso, há título a vencer e não há
        inadimplência nem efetividade comparável.
      </p>
    </section>
  );
}

const E = {
  tabela: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
  th: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)", padding: "0 10px 7px", textAlign: "right",
        borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  trAtual: { background: "var(--rv-fundo-suave)" },
  tdSafra: { fontSize: 13.5, fontWeight: 700, padding: "9px 10px 9px 0", color: "var(--rv-tinta)",
             borderBottom: "1px solid var(--rv-borda-suave)" },
  selo: { marginLeft: 8, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.04em", color: "var(--rv-texto-fraco)" },
  tdValor: { fontSize: 13, padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap",
             fontWeight: 600, borderBottom: "1px solid var(--rv-borda-suave)" },
  tdPct: { fontSize: 13, fontWeight: 800, padding: "9px 10px", textAlign: "right",
           whiteSpace: "nowrap", color: "var(--rv-azul-texto)",
           borderBottom: "1px solid var(--rv-borda-suave)" },
};
