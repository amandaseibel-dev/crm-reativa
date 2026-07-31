import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Confirmacoes de acordo SEM VALOR (valor_informado=0 e valor_entrada=0) que
// ficaram presas AGUARDANDO_CONFIRMACAO. O caso ja saiu das filas operacionais;
// aqui a gestao apenas CONCLUI a confirmacao como saldo zero (encerra a
// solicitacao). Nao mexe de novo em carteira/fila -- isso ja ocorreu.
//
// A conclusao roda a validacao de saldo zero ja criada no banco
// (concluir_confirmacao_saldo_zero -> caso_saldo_operacional): se o aluno ainda
// tiver saldo real em aberto, o banco bloqueia. Exige motivo. So gestao.

const PAGE_SIZE = 1000;
const GESTAO = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br", // Fernanda
  "cobranca07@aelbra.com.br", // Amanda ADM
];

function formatarData(data) {
  if (!data) return "-";
  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

export default function ConfirmacoesSemValor({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [busca, setBusca] = useState("");
  const [motivos, setMotivos] = useState({});
  const [processando, setProcessando] = useState({});
  const [email, setEmail] = useState("");
  const [mensagem, setMensagem] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail((data?.user?.email || "").toLowerCase()));
    carregar();
  }, []);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  async function carregar() {
    setCarregando(true);
    let from = 0;
    const todos = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("solicitacoes_confirmacao_pagamento")
          .select("id, aluno_id, aluno_nome, aluno_cpf, operador_email, operador_nome, forma_pagamento, motivo, criado_em")
          .eq("status", "AGUARDANDO_CONFIRMACAO")
          .or("valor_informado.is.null,valor_informado.eq.0")
          .order("criado_em", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const lote = (data || []).filter((s) => !Number(s.valor_entrada || 0));
        todos.push(...lote);
        if ((data || []).length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      setLista(todos);
    } catch (e) {
      console.error("Erro ao carregar confirmacoes sem valor:", e);
    } finally {
      setCarregando(false);
    }
  }

  const podeConcluir = GESTAO.includes(email);

  async function concluir(s) {
    if (processando[s.id]) return;
    const motivo = (motivos[s.id] || "").trim();
    if (!motivo) {
      alert("Escreva o motivo antes de concluir como saldo zero (ex.: acordo sem valor, saldo já zerado, conciliação).");
      return;
    }
    setProcessando((p) => ({ ...p, [s.id]: true }));
    try {
      const { data, error } = await supabase.rpc("concluir_confirmacao_saldo_zero", {
        p_confirmacao_id: s.id,
        p_motivo: motivo,
      });
      if (error) {
        alert("Não foi possível concluir: " + error.message);
        return;
      }
      // Atualiza a lista imediatamente, sem recarregar a pagina.
      setLista((atual) => atual.filter((x) => x.id !== s.id));
      setMensagem(
        data?.ja_processado
          ? `Confirmação de ${s.aluno_nome || "aluno"} já estava concluída.`
          : `Confirmação de ${s.aluno_nome || "aluno"} concluída como saldo zero.`
      );
    } catch (e) {
      alert("Erro ao concluir: " + (e?.message || String(e)));
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[s.id];
        return n;
      });
    }
  }

  const filtrada = lista.filter((s) => {
    if (!busca.trim()) return true;
    const t = busca.trim().toLowerCase();
    const cpf = t.replace(/\D/g, "");
    return (
      String(s.aluno_nome || "").toLowerCase().includes(t) ||
      (cpf && String(s.aluno_cpf || "").replace(/\D/g, "").includes(cpf))
    );
  });

  if (carregando) {
    return <p style={{ padding: 16, opacity: 0.7 }}>Carregando confirmações sem valor...</p>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      <p style={{ fontSize: 13, color: "#8a93a3", marginBottom: 12 }}>
        Confirmações de acordo <strong>sem valor informado</strong> que ficaram presas na fila. O caso
        já saiu das filas operacionais — aqui você apenas <strong>conclui</strong> a confirmação como
        saldo zero. O sistema valida o saldo real do aluno antes de concluir; financeiro e histórico
        são preservados.
      </p>

      <input
        placeholder="Buscar por nome ou CPF..."
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e3e7ee", fontSize: 13, marginBottom: 12, width: 280 }}
      />

      <p style={{ fontSize: 12.5, color: "#8a93a3", marginBottom: 10 }}>
        <strong>{filtrada.length}</strong> de {lista.length} confirmação(ões) sem valor
      </p>

      {mensagem && (
        <p style={{ color: "#0f7a4f", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{mensagem}</p>
      )}

      {!podeConcluir && (
        <p style={{ color: "#b45309", fontSize: 12.5, marginBottom: 10 }}>
          Somente Amanda, Fernanda e Amanda ADM podem concluir como saldo zero.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtrada.slice(0, 300).map((s) => (
          <div key={s.id} style={card}>
            <div style={cardTopo}>
              <div>
                <span style={nome}>{s.aluno_nome || "Aluno sem nome"}</span>
                <span style={cpf}>CPF {s.aluno_cpf || "-"}</span>
              </div>
              <button
                type="button"
                onClick={() => window.open(`/aluno?alunoId=${s.aluno_id}`, "_blank")}
                style={btnFicha}
              >
                Ver ficha
              </button>
            </div>
            <div style={metaLinha}>
              <span>Informado por: <strong>{s.operador_nome || s.operador_email || "-"}</strong></span>
              <span>Enviado em: {formatarData(s.criado_em)}</span>
            </div>
            {s.motivo && <p style={obs}>Obs. do operador: {s.motivo}</p>}

            <div style={acaoLinha}>
              <input
                placeholder="Motivo (obrigatório)"
                value={motivos[s.id] || ""}
                onChange={(e) => setMotivos((m) => ({ ...m, [s.id]: e.target.value }))}
                disabled={!podeConcluir}
                style={inputMotivo}
              />
              <button
                type="button"
                onClick={() => concluir(s)}
                disabled={!podeConcluir || processando[s.id]}
                style={{ ...btnConcluir, ...((!podeConcluir || processando[s.id]) ? btnBusy : {}) }}
                title="Roda a validação de saldo zero e encerra a confirmação. Não mexe nas filas (já retirado)."
              >
                {processando[s.id] ? "Concluindo..." : "Concluir como saldo zero"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {filtrada.length > 300 && (
        <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
          Mostrando 300 de {filtrada.length} — refine a busca pra achar mais rápido.
        </p>
      )}
      {filtrada.length === 0 && (
        <p style={{ color: "#64748b", fontSize: 14 }}>Nenhuma confirmação sem valor pendente.</p>
      )}
    </div>
  );
}

const card = { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" };
const cardTopo = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" };
const nome = { fontSize: 14.5, fontWeight: 800, color: "#0d1321", marginRight: 10 };
const cpf = { fontSize: 12.5, color: "#64748b", fontWeight: 600 };
const btnFicha = { background: "#eef2ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const metaLinha = { display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, color: "#475569", marginTop: 6 };
const obs = { margin: "6px 0 0", fontSize: 12.5, color: "#64748b" };
const acaoLinha = { display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" };
const inputMotivo = { flex: 1, minWidth: 220, padding: "8px 10px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 13 };
const btnConcluir = { background: "#0f766e", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
const btnBusy = { opacity: 0.55, cursor: "not-allowed" };
