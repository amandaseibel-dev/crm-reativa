import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, num, dataCurta } from "./situacoesDaSafraFormato";

// STATUS ACADÊMICO POR SAFRA — 2024, 2025 e 2026/1 lado a lado.
//
// Pedido da gestão em 07/10/2026: uma visão só para comparar os status das três
// safras, em vez de trocar o seletor três vezes e anotar no papel.
//
// LÊ SNAPSHOT, não recalcula. São três chamadas a `carteira_academico_perfil_ler`
// — a mesma RPC que "Alunos por status" já usa, de 0,24 a 3,70 ms cada.
// `carteira_academico_universo` não é tocada: reconstruí-la é justamente o que
// estourava o teto de 8s e derrubava o bloco.
//
// NENHUM AGRUPAMENTO NOVO. As linhas são as categorias que a base devolve, e o
// casamento entre safras é por rótulo EXATO. Categoria que não existe numa safra
// aparece como "—" — nunca é somada a outra parecida, nunca vira "Outros".
// "(sem situação importada)" é uma categoria da base como qualquer outra e fica
// com o rótulo que a base dá.
//
// 2026/2 não entra: a visão por vencimento não tem perfil acadêmico. As seis
// linhas financeiras são de outro caminho e não aparecem aqui.

const SAFRAS = [
  { chave: "2024",   ano: "2024", semestre: null, rotulo: "2024" },
  { chave: "2025",   ano: "2025", semestre: null, rotulo: "2025" },
  { chave: "2026/1", ano: "2026", semestre: "1",  rotulo: "2026/1" },
];

// Uma casa SEMPRE (7,0% e não 7%), para a coluna ficar alinhada; e categoria
// com aluno de verdade nunca vira "0%": numa safra de alguns milhares, um único
// aluno dá menos de 0,05%, e exibir "0%" faz o leitor achar que não há ninguém
// ali. Abaixo disso o card mostra "<0,1%".
const pct = (parte, todo) => {
  if (!(Number(todo) > 0)) return "—";
  const v = 100 * Number(parte) / Number(todo);
  if (v > 0 && v < 0.05) return "<0,1%";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
};

export default function StatusAcademicoPorSafra() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const rs = await Promise.all(
        SAFRAS.map((s) => supabase.rpc("carteira_academico_perfil_ler",
          { p_ano: s.ano, p_semestre: s.semestre })));
      if (!ativo) return;
      const falhou = rs.find((r) => r.error);
      if (falhou) { setErro(falhou.error.message); setCarregando(false); return; }
      setDados(rs.map((r) => r.data || null));
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <p style={S.discreto}>Comparando os status das três safras…</p>;
  if (erro) return <p style={S.erro}>Não foi possível comparar os status: {erro}</p>;

  const colunas = SAFRAS.map((s, i) => {
    const p = dados?.[i];
    const lista = p?.importacao?.situacoes || [];
    return {
      ...s,
      semSnapshot: Boolean(p?.sem_snapshot),
      total: lista.reduce((t, x) => t + Number(x.alunos || 0), 0),
      // por rótulo EXATO: a chave do mapa é a string que a base devolveu
      porStatus: new Map(lista.map((x) => [x.situacao, Number(x.alunos || 0)])),
      gerado_em: p?.snapshot?.gerado_em || null,
    };
  });

  if (colunas.every((c) => c.semSnapshot)) {
    return (
      <p style={S.discreto}>
        Nenhuma das três safras tem fotografia acadêmica ainda. A rotina diária gera; assim que rodar,
        a comparação aparece.
      </p>
    );
  }

  // União das categorias, ordenada pelo total somado — a maior em cima. Somar
  // ENTRE safras aqui é só ordenação da tabela; nenhum número exibido vem dessa
  // soma, e safra nenhuma é misturada com outra em célula alguma.
  const categorias = [...new Set(colunas.flatMap((c) => [...c.porStatus.keys()]))]
    .sort((a, b) => {
      const t = (k) => colunas.reduce((s, c) => s + (c.porStatus.get(k) ?? 0), 0);
      return t(b) - t(a) || a.localeCompare(b, "pt-BR");
    });

  // o maior status DE CADA safra, para o destaque — um por coluna
  const maiorDa = colunas.map((c) =>
    [...c.porStatus.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);

  const faltando = colunas.filter((c) => c.semSnapshot);
  const fotografias = colunas.filter((c) => c.gerado_em).map((c) => c.gerado_em).sort();

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Status acadêmico por safra</h2>
        <span style={S.apoio}>
          {categorias.length} {categorias.length === 1 ? "categoria" : "categorias"} · 2024, 2025 e 2026/1
        </span>
      </div>

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Status</th>
              {colunas.map((c) => (
                <th key={c.chave} style={E.th} colSpan={2}>{c.rotulo}</th>
              ))}
            </tr>
            <tr>
              <th style={E.thVazio} />
              {colunas.map((c) => (
                <Fragmento key={c.chave}>
                  <th style={E.thMini}>alunos</th>
                  <th style={E.thMini}>%</th>
                </Fragmento>
              ))}
            </tr>
          </thead>
          <tbody>
            {categorias.map((cat) => (
              <tr key={cat}>
                <td style={E.tdStatus}>{cat}</td>
                {colunas.map((c, i) => {
                  const n = c.porStatus.get(cat);
                  const destaque = maiorDa[i] === cat;
                  return (
                    <Fragmento key={c.chave}>
                      <td style={{ ...E.tdNum, ...(destaque ? E.destaque : null) }}>
                        {n === undefined ? "—" : num(n)}
                      </td>
                      <td style={{ ...E.tdPct, ...(destaque ? E.destaque : null) }}>
                        {n === undefined ? "—" : pct(n, c.total)}
                      </td>
                    </Fragmento>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={E.tdTotalRotulo}>Total de alunos</td>
              {colunas.map((c) => (
                <Fragmento key={c.chave}>
                  <td style={E.tdTotal}>{c.semSnapshot ? "—" : num(c.total)}</td>
                  <td style={E.tdTotal}>{c.semSnapshot ? "—" : "100%"}</td>
                </Fragmento>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Em negrito, o maior status de cada safra.</strong> O percentual é sempre sobre o total
        <strong> daquela</strong> safra — as colunas não se somam entre si, e um aluno de 2024 não é o mesmo
        de 2025. Categoria que não existe na safra aparece como “—”, nunca somada a outra parecida.
      </p>
      {faltando.length ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          Sem fotografia ainda: {faltando.map((c) => c.rotulo).join(", ")}. A rotina diária gera.
        </p>
      ) : null}
      {fotografias.length ? (
        <p style={S.rodape}>
          Situação acadêmica do relatório de inadimplência importado. Fotografias desta comparação tiradas
          em {dataCurta(fotografias[0])}
          {fotografias[0] !== fotografias[fotografias.length - 1]
            ? " a " + dataCurta(fotografias[fotografias.length - 1]) : ""}.
        </p>
      ) : null}
    </section>
  );
}

// Fragmento nomeado: duas células por safra sem embrulhar em elemento, que
// quebraria o alinhamento da tabela.
function Fragmento({ children }) {
  return <>{children}</>;
}

const E = {
  tabela: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
  th: { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)", padding: "0 10px 6px", textAlign: "right",
        borderBottom: "1px solid var(--rv-borda-suave)" },
  thVazio: { borderBottom: "1px solid var(--rv-borda-suave)" },
  thMini: { fontSize: 10.5, fontWeight: 600, color: "var(--rv-texto-fraco)",
            padding: "4px 10px 6px", textAlign: "right",
            borderBottom: "1px solid var(--rv-borda-suave)" },
  tdStatus: { fontSize: 13, padding: "7px 10px 7px 0", color: "var(--rv-tinta)",
              borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { fontSize: 13, padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap",
           borderBottom: "1px solid var(--rv-borda-suave)" },
  tdPct: { fontSize: 12, padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap",
           color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)" },
  destaque: { fontWeight: 800, color: "var(--rv-azul-texto)" },
  tdTotalRotulo: { fontSize: 12.5, fontWeight: 700, padding: "9px 10px 0 0" },
  tdTotal: { fontSize: 13, fontWeight: 700, padding: "9px 10px 0", textAlign: "right",
             whiteSpace: "nowrap" },
};
