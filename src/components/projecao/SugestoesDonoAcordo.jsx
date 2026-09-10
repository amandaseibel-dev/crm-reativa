import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

// Pagamento creditado a quem NAO e o dono do acordo.
//
// A Fernanda fecha acordo fora do turno para o operador, e o credito acaba indo
// para quem registrou -- nao para quem cobrou. Esta aba SUGERE a correcao; quem
// decide e a gestao, uma linha por vez. Automatizar seria mexer em comissao sem
// ninguem olhar.
//
// So aparece aluno com UM acordo ativo: com dois ou mais nao da pra saber a qual
// deles o pagamento pertence, e o palpite viraria dinheiro na mao errada.
const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("pt-BR") : "—");
const mesAtual = () => new Date().toISOString().slice(0, 7);

export default function SugestoesDonoAcordo() {
  const [mes, setMes] = useState(mesAtual());
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [aplicando, setAplicando] = useState({});
  // O credito que veio com nome de fora (arquivo do Santander) e uma decisao
  // diferente do credito entre dois operadores da equipe: separa-se por padrao.
  const [soEntreOperadores, setSoEntreOperadores] = useState(true);

  const carregar = useCallback(async (m) => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("projecao_sugestoes_dono_acordo", { p_mes: m });
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar as sugestões: " + (error.message || ""));
      return;
    }
    setLista(data || []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar(mes);
  }, [mes, carregar]);

  async function aplicar(s) {
    const ok = window.confirm(
      `Passar este pagamento para ${s.dono_acordo_nome}?\n\n` +
        `${s.aluno_nome} — ${moeda(s.valor_pago)}\n` +
        `Hoje está creditado para ${s.creditado_nome || "(sem operador)"}.\n\n` +
        `A Projeção do mês é recalculada e a troca fica registrada como ajuste manual.`
    );
    if (!ok) return;
    setAplicando((a) => ({ ...a, [s.pagamento_id]: true }));
    setAviso("");
    const { error } = await supabase.rpc("projecao_alterar_operador", {
      p_pagamento_id: s.pagamento_id,
      p_novo_operador_email: s.dono_acordo_email,
      p_novo_operador_nome: s.dono_acordo_nome,
      p_motivo: "Pagamento atrelado ao dono do acordo (sugestão da Projeção)",
    });
    setAplicando((a) => ({ ...a, [s.pagamento_id]: false }));
    if (error) {
      setAviso("Não foi possível aplicar: " + (error.message || ""));
      return;
    }
    setAviso(`Pagamento de ${s.aluno_nome} passou para ${s.dono_acordo_nome}.`);
    carregar(mes);
  }

  const visiveis = soEntreOperadores ? lista.filter((s) => s.entre_operadores) : lista;
  const total = visiveis.reduce((t, s) => t + Number(s.valor_pago || 0), 0);
  const deFora = lista.filter((s) => !s.entre_operadores).length;

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h3 style={S.titulo}>Pagamentos que deveriam ser de outro operador</h3>
          <p style={S.sub}>
            O crédito foi para uma pessoa e o acordo é de outra. Confira e passe para o
            dono do acordo — nada muda sozinho.
          </p>
        </div>
        <div style={S.filtros}>
          <input
            type="month"
            value={mes}
            onChange={(e) => setMes(e.target.value)}
            style={S.input}
          />
          <label style={S.check}>
            <input
              type="checkbox"
              checked={soEntreOperadores}
              onChange={(e) => setSoEntreOperadores(e.target.checked)}
            />
            Só entre operadores da equipe
          </label>
          <button type="button" style={S.btnGhost} onClick={() => carregar(mes)}>
            Atualizar
          </button>
        </div>
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}
      {aviso ? <p style={S.aviso}>{aviso}</p> : null}

      {carregando ? (
        <p style={S.muted}>Carregando…</p>
      ) : !visiveis.length ? (
        <p style={S.muted}>
          Nenhuma sugestão neste mês.
          {soEntreOperadores && deFora > 0
            ? ` Há ${deFora} com crédito de nome de fora da equipe — desmarque o filtro para ver.`
            : ""}
        </p>
      ) : (
        <>
          <p style={S.resumo}>
            {visiveis.length} pagamento(s) · {moeda(total)}
            {soEntreOperadores && deFora > 0 ? ` · ${deFora} de fora da equipe ocultos` : ""}
          </p>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Data</th>
                <th style={S.th}>Aluno</th>
                <th style={S.thNum}>Valor</th>
                <th style={S.th}>Creditado hoje</th>
                <th style={S.th}>Dono do acordo</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((s) => (
                <tr key={s.pagamento_id}>
                  <td style={S.td}>{dia(s.data_pagamento)}</td>
                  <td style={S.td}>
                    {s.aluno_nome || "—"}
                    {s.ja_ajustado ? <span style={S.selo}>🔁 já ajustado antes</span> : null}
                  </td>
                  <td style={S.tdNum}>{moeda(s.valor_pago)}</td>
                  <td style={S.td}>{s.creditado_nome || "(sem operador)"}</td>
                  <td style={{ ...S.td, fontWeight: 700 }}>{s.dono_acordo_nome}</td>
                  <td style={S.td}>
                    <button
                      type="button"
                      style={aplicando[s.pagamento_id] ? { ...S.btnAplicar, opacity: 0.5 } : S.btnAplicar}
                      disabled={!!aplicando[s.pagamento_id]}
                      onClick={() => aplicar(s)}
                    >
                      Passar para {s.dono_acordo_nome?.split(" ")[0]}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "18px 4px" },
  topo: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  titulo: { margin: 0, fontSize: 17, fontWeight: 800, color: "var(--rv-tinta)" },
  sub: { margin: "4px 0 0", fontSize: 13, color: "var(--rv-texto-suave)", maxWidth: 620 },
  filtros: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "7px 10px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)" },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--rv-texto-suave)" },
  btnGhost: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  resumo: { fontSize: 13, fontWeight: 700, color: "var(--rv-texto-forte)", margin: "0 0 10px" },
  muted: { color: "var(--rv-texto-suave)", fontSize: 14 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, fontWeight: 600 },
  aviso: { color: "var(--rv-verde-ok-texto)", fontSize: 13, fontWeight: 600 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "var(--rv-superficie)", borderRadius: 10, overflow: "hidden" },
  th: { textAlign: "left", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)" },
  thNum: { textAlign: "right", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)" },
  td: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)" },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700, color: "var(--rv-tinta)" },
  selo: { marginLeft: 8, fontSize: 11, color: "var(--rv-texto-fraco)" },
  btnAplicar: { background: "#15803d", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
};
