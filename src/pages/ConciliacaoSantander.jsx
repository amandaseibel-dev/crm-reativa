// Conciliacao com o extrato do Santander -- a fila que define quem pagou.
//
// Amanda, 29/08/2026: "sempre a fila pela entradas do santander, ali definimos
// quem realmente pagou" e "vamos conseguir trabalhar e estancar os maiores casos
// primeiro".
//
// Uma linha por ALUNO, julho e agosto somados, ordenada pelo MAIOR SALDO -- e nao
// pela maior entrada -- porque o objetivo e estancar primeiro quem ainda deve
// mais. O botao de ordem alterna para "maior entrada" quando a pergunta for
// outra.
//
// O SALDO VEM PARTIDO EM DOIS de proposito: parcela de acordo ja e valor
// NEGOCIADO (embute juros, multa e honorarios) e mensalidade e divida original.
// Sao decisoes diferentes; um total unico esconde isso.
//
// NAO COMPARAR VALOR PAGO COM SALDO. Amanda: "sempre o valor do pagamento a
// vista por exemplo sera maior que o valor principal". O arquivo traz valor
// cheio, o nosso registro traz principal -- entao pagar mais que o saldo e o
// normal de quem quitou a vista, nao anomalia.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

export default function ConciliacaoSantander() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState("SALDO");
  const [fichaId, setFichaId] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const [backlog, setBacklog] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    const [fila, bl] = await Promise.all([
      supabase.rpc("conciliacao_santander", { p_desde: "2026-07-01" }),
      supabase.rpc("backlog_manual"),
    ]);
    if (fila.error) setErro(fila.error.message);
    setLinhas(fila.data || []);
    setBacklog(bl.data || null);
    setCarregando(false);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const visiveis = useMemo(() => {
    let l = linhas;
    const t = busca.trim().toLowerCase();
    if (t) {
      const dig = t.replace(/\D/g, "");
      l = l.filter((x) =>
        String(x.nome || "").toLowerCase().includes(t) ||
        (dig && String(x.cpf || "").replace(/\D/g, "").includes(dig)));
    }
    if (ordem === "ENTRADA") l = [...l].sort((a, b) => Number(b.entrou) - Number(a.entrou));
    return l;
  }, [linhas, busca, ordem]);

  const totEntrou = useMemo(() => visiveis.reduce((s, l) => s + Number(l.entrou || 0), 0), [visiveis]);
  const totSaldo = useMemo(() => visiveis.reduce((s, l) => s + Number(l.saldo_aberto || 0), 0), [visiveis]);

  // Tira a linha da tela na hora: a RPC ja exclui quem tem decisao gravada, mas
  // recarregar 1.365 linhas a cada clique tornaria a fila impraticavel.
  function removerDaTela(alunoId) {
    setLinhas((ls) => ls.filter((x) => x.aluno_id !== alunoId));
  }

  async function decidir(l, decisao, motivo) {
    setOcupado(l.aluno_id);
    try {
      if (decisao === "CONFIRMADO") {
        // Registra a baixa com o valor que entrou no Santander. Quem decide se
        // quita e `confirmar_baixa_caso`: so quita com saldo ZERADO (premissa 3).
        const { error } = await supabase.rpc("confirmar_baixa_caso", {
          p_aluno_id: l.aluno_id,
          p_valor_pago: Number(l.entrou),
          p_data_pagamento: l.ultimo_pagamento,
          p_confirmacao_id: null,
        });
        if (error) throw error;
      }
      if (decisao === "QUITADO") {
        const { error } = await supabase.rpc("quitar_e_encerrar_caso", {
          p_aluno_id: l.aluno_id,
          p_valor: Number(l.entrou),
          p_data: l.ultimo_pagamento,
          p_confirmar_acordo_em_dia: true,
        });
        if (error) throw error;
      }
      const { error: e2 } = await supabase.rpc("conciliacao_santander_decidir", {
        p_aluno_id: l.aluno_id,
        p_decisao: decisao,
        p_motivo: motivo || null,
        p_valor: Number(l.entrou),
      });
      if (e2) throw e2;
      removerDaTela(l.aluno_id);
    } catch (e) {
      alert("Não foi possível concluir: " + (e?.message || String(e)));
    } finally {
      setOcupado(null);
    }
  }

  function rejeitar(l) {
    const motivo = window.prompt(`Por que ${l.nome} não deve ser ajustado?`);
    if (motivo === null) return;
    if (!motivo.trim()) { alert("O motivo é obrigatório para rejeitar."); return; }
    decidir(l, "REJEITADO", motivo.trim());
  }

  function quitarTudo(l) {
    const ok = window.confirm(
      `Quitar TUDO de ${l.nome}?\n\n` +
      `Entrou no Santander: ${moeda(l.entrou)}\n` +
      `Saldo que será encerrado: ${moeda(l.saldo_aberto)}\n\n` +
      `Isso encerra o caso e tira o aluno da cobrança.`);
    if (ok) decidir(l, "QUITADO");
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Conciliação com o Santander</h1>
          <p style={S.sub}>
            Quem entrou no extrato de julho e agosto e ainda tem saldo aqui. Uma linha por aluno,
            com os dois meses somados. O extrato define quem pagou; o saldo diz o que falta ajustar.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <input
          style={S.input}
          placeholder="Buscar por nome ou CPF..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setOrdem(ordem === "SALDO" ? "ENTRADA" : "SALDO")}
          style={S.btnGhost}
          title="Alternar a ordem da fila"
        >
          {ordem === "SALDO" ? "↓ Maior saldo" : "↓ Maior entrada"}
        </button>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{visiveis.length} alunos</span>
          <span style={S.contadorAcordos}>{moeda(totEntrou)} entrou</span>
          <span style={S.contadorValor}>{moeda(totSaldo)} em aberto</span>
        </div>
      </div>

      {backlog ? (
        <p style={contexto}>
          Ainda a lançar: <b>{backlog.pagamentos_sem_baixa}</b> pagamentos
          ({moeda(backlog.pagamentos_sem_baixa_valor)}) sem fechar parcela ou título,
          e <b>{backlog.acordos_sem_vinculo}</b> acordos sem mensalidade vinculada.
          O saldo desta fila cai à medida que isso é feito.
        </p>
      ) : null}

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>Nada pendente de conciliação.</p>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Aluno</th>
              <th style={S.thNum}>Entrou</th>
              <th style={S.thNum}>Saldo</th>
              <th style={S.thNum}>Em acordo</th>
              <th style={S.thNum}>Mensalidade</th>
              <th style={S.thNum}>Vencido</th>
              <th style={S.th}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((l) => (
              <tr key={l.aluno_id}>
                <td style={S.td}>
                  <button type="button" onClick={() => setFichaId(l.aluno_id)} style={linkNome}>
                    {l.nome}
                  </button>
                  <div style={sub}>
                    CPF {l.cpf || "-"} · {l.responsavel} · {l.qtd_pagamentos} pagamento
                    {l.qtd_pagamentos === 1 ? "" : "s"} até {curta(l.ultimo_pagamento)}
                  </div>
                </td>
                <td style={{ ...S.tdNum, fontWeight: 800, color: "#166534" }}>{moeda(l.entrou)}</td>
                <td style={{ ...S.tdNum, fontWeight: 800 }}>{moeda(l.saldo_aberto)}</td>
                <td style={S.tdNum}>{moeda(l.saldo_em_acordo)}</td>
                <td style={S.tdNum}>{moeda(l.saldo_em_mensalidade)}</td>
                <td style={{ ...S.tdNum, color: Number(l.saldo_vencido) > 0 ? "#9f1239" : "#64748b" }}>
                  {moeda(l.saldo_vencido)}
                </td>
                <td style={S.td}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={ocupado === l.aluno_id ? S.btnBusy : S.btnConf}
                      disabled={ocupado === l.aluno_id}
                      onClick={() => decidir(l, "CONFIRMADO")}
                      title="Registra a baixa com o valor do Santander. Só quita se o saldo zerar."
                    >
                      Confirmar
                    </button>
                    <button
                      type="button"
                      style={S.btnRej}
                      disabled={ocupado === l.aluno_id}
                      onClick={() => rejeitar(l)}
                    >
                      Rejeitar
                    </button>
                    <button
                      type="button"
                      style={btnQuitar}
                      disabled={ocupado === l.aluno_id}
                      onClick={() => quitarTudo(l)}
                      title="Encerra o caso inteiro e tira o aluno da cobrança."
                    >
                      Quitar tudo
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const linkNome = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontWeight: 800, fontSize: 13.5, color: "#0f172a", textAlign: "left", textDecoration: "underline",
};
const contexto = { margin: "0 0 12px", fontSize: 12.5, color: "#78350f", background: "#fffbeb",
  border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", maxWidth: 900 };
const sub = { fontSize: 11.5, color: "#64748b", marginTop: 2 };
const btnQuitar = {
  background: "#0f172a", color: "#fff", border: "none", borderRadius: 8,
  padding: "5px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer",
};
