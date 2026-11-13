import { useEffect, useState, useCallback } from "react";
import { supabase } from "../services/supabase";

// Registro ADMINISTRATIVO da situação do termo físico. Não é tabulação e não
// é status operacional: não conta como contato, não renova fidelização, não
// muda retorno, fila nem situação financeira, e "arquivado" não comprova
// quitação nem gera baixa.
//
// QUEM VÊ: a RPC `termo_fisico_ler` só responde para `usuario_e_gestao()` (no
// banco). Para qualquer outro perfil ela recusa, e este componente então NÃO
// renderiza nada. A restrição vale no backend; esconder aqui é só cosmético.
//
// ENQUANTO A MIGRATION NÃO ESTIVER APLICADA a RPC não existe e a chamada falha:
// o componente fica invisível, sem erro na tela.

export const SITUACOES_TERMO_FISICO = Object.freeze({
  EM_ANDAMENTO: "Termo físico assinado, em andamento",
  ARQUIVADO: "Termo físico arquivado",
});

export function rotuloSituacaoTermoFisico(situacao) {
  return SITUACOES_TERMO_FISICO[situacao] || "Sem registro";
}

function formatarQuando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function RegistroTermoFisico({ alunoId }) {
  const [estado, setEstado] = useState({ carregando: true, indisponivel: false, situacao: null, eventos: [] });
  const [escolha, setEscolha] = useState("EM_ANDAMENTO");
  const [notificar, setNotificar] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    if (!alunoId) return;
    const { data, error } = await supabase.rpc("termo_fisico_ler", { p_aluno_id: String(alunoId) });
    if (error || !data) {
      setEstado({ carregando: false, indisponivel: true, situacao: null, eventos: [] });
      return;
    }
    setEstado({
      carregando: false,
      indisponivel: false,
      situacao: data.situacao || null,
      eventos: Array.isArray(data.eventos) ? data.eventos : [],
    });
  }, [alunoId]);

  useEffect(() => {
    setEstado((e) => ({ ...e, carregando: true, indisponivel: false }));
    carregar();
  }, [carregar]);

  if (estado.carregando || estado.indisponivel) return null;

  async function registrar() {
    setSalvando(true);
    const { error } = await supabase.rpc("termo_fisico_registrar", {
      p_aluno_id: String(alunoId),
      p_situacao: escolha,
      p_notificar: notificar,
    });
    setSalvando(false);
    if (error) {
      alert("Não foi possível registrar o termo físico: " + (error.message || "erro"));
      return;
    }
    setNotificar(false);
    await carregar();
  }

  return (
    <section
      aria-label="Termo físico (administrativo)"
      style={{
        border: "1px solid #7c3aed",
        background: "#f5f3ff",
        borderRadius: 8,
        padding: 12,
        margin: "10px 0",
      }}
    >
      <div style={{ fontWeight: 700, color: "#5b21b6", marginBottom: 6 }}>
        Termo físico · registro administrativo
      </div>
      <div style={{ marginBottom: 8 }}>
        Situação atual: <strong>{rotuloSituacaoTermoFisico(estado.situacao)}</strong>
      </div>

      {estado.eventos.length > 0 && (
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13 }}>
          {estado.eventos.map((ev) => (
            <li key={ev.id}>
              {formatarQuando(ev.registrado_em)} · {rotuloSituacaoTermoFisico(ev.situacao)} · {ev.autor_email}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={escolha} onChange={(e) => setEscolha(e.target.value)} disabled={salvando}>
          <option value="EM_ANDAMENTO">{SITUACOES_TERMO_FISICO.EM_ANDAMENTO}</option>
          <option value="ARQUIVADO">{SITUACOES_TERMO_FISICO.ARQUIVADO}</option>
        </select>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={notificar} onChange={(e) => setNotificar(e.target.checked)} disabled={salvando} />{" "}
          Notificar a gestão
        </label>
        <button type="button" onClick={registrar} disabled={salvando}>
          {salvando ? "Registrando..." : "Registrar"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
        Não é tabulação: não altera contato, retorno, fila, fidelização nem situação financeira. Arquivado não comprova quitação.
      </div>
    </section>
  );
}
