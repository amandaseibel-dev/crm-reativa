import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S, num, dataCurta } from "./situacoesDaSafraFormato";

// STATUS ACADÊMICO POR SAFRA — 2024, 2025 e 2026/1 lado a lado, em alunos,
// títulos e DINHEIRO.
//
// A pergunta que este card responde, pedida pela gestão em 07/10/2026: "quantos
// alunos de cada status acadêmico estão inadimplentes e qual o saldo em aberto
// deles?". A versão anterior só sabia contar alunos; o saldo por status não
// existia em lugar nenhum.
//
// LÊ SNAPSHOT, UMA chamada. `carteira_academico_saldo_ler` devolve as três
// safras de uma vez. Reconstruir o universo no nível de título é mais caro do
// que a reconstrução por aluno que já estourava o teto de 8s do papel
// `authenticated` — foi por isso que "Alunos por status" virou snapshot em 06/10.
//
// OS TOTAIS FECHAM, E NÃO SÃO DECORADOS. O recálculo no banco asserta que a
// quebra por status soma o total da safra, e aborta em vez de gravar se não
// fechar. Nenhum número está fixado aqui: 2026/1 é calculado da base viva e se
// move ao longo do dia.
//
// NENHUM AGRUPAMENTO. Linha = valor cru de `situacao_academica`, casada entre
// safras por rótulo EXATO. "Matriculado Curso Normal" e "Aguardando Matrícula"
// são linhas SEPARADAS. Categoria que não existe numa safra aparece "—", nunca
// somada a outra parecida, nunca vira "Outros".
//
// COBERTURA INCOMPLETA FICA À MOSTRA. "(sem situação importada)" é linha real,
// destacada em âmbar, e a safra em que ela pesa mais de um décimo do saldo ganha
// um aviso com o percentual — decisão da gestão em 07/10/2026: não esconder.
//
// NÃO SOMA AS TRÊS SAFRAS. Há CPF em mais de uma safra; um total das três seria
// contagem dupla. O payload nem traz esse total, e aqui não existe essa célula.
//
// 2026/2 não entra: a visão por vencimento não tem perfil acadêmico. As seis
// linhas financeiras vêm de outro caminho e não aparecem aqui.

const ROTULO = { 2024: "2024", 2025: "2025", "2026/1": "2026/1" };
const SEM_SITUACAO = "(sem situação importada)";

// Limite a partir do qual a ausência de dado deixa de ser rodapé e passa a ser
// aviso: um décimo do saldo da safra. Abaixo disso a linha da tabela já conta a
// história; acima, o leitor precisa saber antes de interpretar as outras linhas.
const AVISO_COBERTURA = 10;

// Duas casas no dinheiro, uma no percentual; e categoria com aluno de verdade
// nunca vira "0,0%" — numa safra de milhares um único aluno dá menos de 0,05%, e
// "0,0%" faz o leitor achar que não há ninguém ali.
const pctTexto = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.05) return "<0,1%";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
};
// Na tabela o "R$" vai no cabeçalho, não em cada célula: doze colunas de moeda
// com símbolo repetido viram ruído e empurram a tabela para fora da tela.
const valor = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function StatusAcademicoPorSafra() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [compacto, setCompacto] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("carteira_academico_saldo_ler");
      if (!ativo) return;
      if (error) { setErro(error.message); setCarregando(false); return; }
      setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  const colunas = useMemo(() => {
    const safras = dados?.safras || [];
    return safras.map((s) => ({
      chave: s.recorte,
      rotulo: ROTULO[s.recorte] || s.recorte,
      total: s.total || { alunos: 0, titulos: 0, saldo: 0 },
      // casamento por rótulo EXATO: a chave é a string que a base devolveu
      porStatus: new Map((s.linhas || []).map((l) => [l.situacao, l])),
      fonteAcademicaEm: s.fonte_academica?.atualizado_em || null,
      geradoEm: s.snapshot?.gerado_em || null,
      conferencia: s.conferencia || null,
    }));
  }, [dados]);

  if (carregando) return <p style={S.discreto}>Cruzando status acadêmico com o saldo em aberto…</p>;
  if (erro) return <p style={S.erro}>Não foi possível cruzar status e saldo: {erro}</p>;

  if (!colunas.length) {
    return (
      <p style={S.discreto}>
        Nenhuma safra tem fotografia do cruzamento ainda. A rotina diária gera; assim que rodar,
        a comparação aparece.
      </p>
    );
  }

  // União das categorias, ordenada pelo saldo somado — a maior em cima. Somar
  // ENTRE safras aqui é só ordenação da tabela; nenhum número exibido vem dessa
  // soma. "(sem situação importada)" fica no fim, para a tabela abrir pelas
  // categorias que têm nome.
  const categorias = [...new Set(colunas.flatMap((c) => [...c.porStatus.keys()]))]
    .sort((a, b) => {
      if (a === SEM_SITUACAO) return 1;
      if (b === SEM_SITUACAO) return -1;
      const t = (k) => colunas.reduce((s, c) => s + Number(c.porStatus.get(k)?.saldo || 0), 0);
      return t(b) - t(a) || a.localeCompare(b, "pt-BR");
    });

  // o status de MAIOR SALDO de cada safra, para o destaque — um por coluna
  const maiorDa = colunas.map((c) =>
    [...c.porStatus.values()].sort((a, b) => Number(b.saldo) - Number(a.saldo))[0]?.situacao ?? null);

  // as safras em que a ausência de situação acadêmica pesa o bastante para virar aviso
  const avisos = colunas
    .map((c) => ({ rotulo: c.rotulo, linha: c.porStatus.get(SEM_SITUACAO), total: c.total }))
    .filter((a) => a.linha && Number(a.linha.pct) >= AVISO_COBERTURA);

  const fontes = [...new Set(colunas.map((c) => c.fonteAcademicaEm).filter(Boolean))].sort();
  const fotos = colunas.map((c) => c.geradoEm).filter(Boolean).sort();
  const naoFecha = colunas.filter(
    (c) => c.conferencia && Number(c.conferencia.saldo) !== Number(c.total.saldo));

  const metricas = compacto
    ? [{ k: "saldo", r: "saldo R$" }, { k: "pct", r: "% saldo" }]
    : [{ k: "alunos", r: "alunos" }, { k: "titulos", r: "títulos" },
       { k: "saldo", r: "saldo R$" }, { k: "pct", r: "% saldo" }];

  const celula = (l, k) => {
    if (!l) return "—";
    if (k === "pct") return pctTexto(l.pct);
    if (k === "saldo") return valor(l.saldo);
    return num(l[k]);
  };

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Status acadêmico por safra</h2>
        <span style={S.apoio}>
          {categorias.length} {categorias.length === 1 ? "categoria" : "categorias"} ·{" "}
          alunos inadimplentes, títulos em aberto e saldo
          {" · "}
          <button type="button" style={E.alternar} onClick={() => setCompacto((v) => !v)}>
            {compacto ? "mostrar alunos e títulos" : "só saldo"}
          </button>
        </span>
      </div>

      {avisos.map((a) => (
        <p key={a.rotulo} style={E.aviso}>
          <strong>{a.rotulo}:</strong> {pctTexto(a.linha.pct)} do saldo está sem situação acadêmica
          importada — {num(a.linha.alunos)} de {num(a.total.alunos)} alunos, R$ {valor(a.linha.saldo)}.
          A linha está na tabela; não foi redistribuída nem omitida. Qualquer leitura desta safra por
          status descreve o resto do saldo, não o total.
        </p>
      ))}

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Status</th>
              {colunas.map((c) => (
                <th key={c.chave} style={E.th} colSpan={metricas.length}>{c.rotulo}</th>
              ))}
            </tr>
            <tr>
              <th style={E.thVazio} />
              {colunas.map((c) => (
                <Fragmento key={c.chave}>
                  {metricas.map((m) => (
                    <th key={m.k} style={E.thMini}>{m.r}</th>
                  ))}
                </Fragmento>
              ))}
            </tr>
          </thead>
          <tbody>
            {categorias.map((cat) => {
              const semDado = cat === SEM_SITUACAO;
              return (
                <tr key={cat}>
                  <td style={{ ...E.tdStatus, ...(semDado ? E.tdSemDado : null) }}>
                    {cat}
                    {semDado ? <span style={E.selo}>cobertura incompleta</span> : null}
                  </td>
                  {colunas.map((c, i) => {
                    const l = c.porStatus.get(cat);
                    const destaque = maiorDa[i] === cat;
                    return (
                      <Fragmento key={c.chave}>
                        {metricas.map((m) => (
                          <td key={m.k} style={{
                            ...E.tdNum,
                            ...(m.k === "pct" ? E.tdPct : null),
                            ...(destaque ? E.destaque : null),
                            ...(semDado ? E.tdSemDado : null),
                          }}>
                            {celula(l, m.k)}
                          </td>
                        ))}
                      </Fragmento>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={E.tdTotalRotulo}>Total da safra</td>
              {colunas.map((c) => (
                <Fragmento key={c.chave}>
                  {metricas.map((m) => (
                    <td key={m.k} style={E.tdTotal}>
                      {m.k === "pct" ? "100,00%"
                        : m.k === "saldo" ? valor(c.total.saldo)
                        : num(c.total[m.k])}
                    </td>
                  ))}
                </Fragmento>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Em negrito, o status de maior saldo de cada safra.</strong> Alunos são inadimplentes
        únicos — aluno com vários títulos conta uma vez, e o saldo dos títulos dele entra uma vez cada.
        O percentual é sempre sobre o saldo <strong>daquela</strong> safra. As colunas{" "}
        <strong>não se somam entre si</strong>: há CPF em mais de uma safra, e um total das três
        contaria a mesma pessoa duas vezes — por isso ele não existe nesta tabela.
      </p>
      <p style={S.rodape}>
        Situação acadêmica do relatório de inadimplência{" "}
        <strong>importado em {fontes.length ? dataCurta(fontes[fontes.length - 1]) : "data não registrada"}</strong>
        {fontes.length > 1 ? ` (a mais antiga das safras é de ${dataCurta(fontes[0])})` : ""}. Status
        que mudou depois disso ainda não aparece aqui.
      </p>
      {fotos.length ? (
        <p style={S.rodape}>
          Cruzamento com o saldo tirado em {dataCurta(fotos[0])}
          {fotos[0] !== fotos[fotos.length - 1] ? " a " + dataCurta(fotos[fotos.length - 1]) : ""} —
          o saldo de 2026/1 é calculado da carteira viva e se move ao longo do dia.
        </p>
      ) : null}
      {naoFecha.length ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          Conferência com a fonte oficial da safra: {naoFecha.map((c) => c.rotulo).join(", ")} está em
          R$ {valor(naoFecha[0].total.saldo)} aqui e R$ {valor(naoFecha[0].conferencia.saldo)} no
          snapshot financeiro — fotografias de instantes diferentes.
        </p>
      ) : null}
    </section>
  );
}

// Fragmento nomeado: várias células por safra sem embrulhar em elemento, que
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
            padding: "4px 10px 6px", textAlign: "right", whiteSpace: "nowrap",
            borderBottom: "1px solid var(--rv-borda-suave)" },
  tdStatus: { fontSize: 13, padding: "7px 10px 7px 0", color: "var(--rv-tinta)", whiteSpace: "nowrap",
              borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { fontSize: 13, padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap",
           borderBottom: "1px solid var(--rv-borda-suave)" },
  tdPct: { fontSize: 12, color: "var(--rv-texto-suave)" },
  tdSemDado: { background: "var(--rv-ambar-fundo)" },
  selo: { marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
          textTransform: "uppercase", color: "var(--rv-ambar-texto)" },
  destaque: { fontWeight: 800, color: "var(--rv-azul-texto)" },
  tdTotalRotulo: { fontSize: 12.5, fontWeight: 700, padding: "9px 10px 0 0", whiteSpace: "nowrap" },
  tdTotal: { fontSize: 13, fontWeight: 700, padding: "9px 10px 0", textAlign: "right",
             whiteSpace: "nowrap" },
  aviso: { margin: "0 0 12px", padding: "10px 12px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.5,
           background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)",
           border: "1px solid var(--rv-ambar-borda)" },
  alternar: { background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer",
              color: "var(--rv-azul-texto)", textDecoration: "underline" },
};
