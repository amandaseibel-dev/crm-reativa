// "Assumir caso disponível" -- o operador pega, para si, o caso de OUTRO operador
// cuja fidelização de 10 dias já venceu (11º dia sem acionamento válido).
//
// Não escolhe destinatário: o banco usa o usuário autenticado. A elegibilidade
// (prazo de 10 dias, proteções, teto) é decidida SÓ no banco. A tela não calcula
// dias nem repete a regra: mostra o botão e exibe a resposta da RPC.
//
// LIMITAÇÃO NESTA ENTREGA: casos fidelizados pelo giro de carteira (giro de 16/10)
// NÃO entram nesta ação. Vão continuar pela regra antiga até a #936 ser aplicada.
import { useState } from "react";
import { supabase } from "../services/supabase";

const MSG_INDISPONIVEL = "Este caso não está disponível para assumir.";
const MSG_FALHA = "Não foi possível assumir agora. Tente novamente.";

export default function AssumirCasoDisponivel({ alunoId, responsavelEmail, usuarioEmail, onAssumido }) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState(null); // { tipo: "ok" | "erro", texto }

  const outroOperador =
    responsavelEmail && usuarioEmail &&
    responsavelEmail.toLowerCase() !== usuarioEmail.toLowerCase();
  if (!outroOperador) return null;

  async function assumir() {
    const m = motivo.trim();
    if (!m) {
      setAviso({ tipo: "erro", texto: "Informe o motivo para assumir o caso." });
      return;
    }
    setEnviando(true);
    setAviso(null);
    try {
      const { data, error } = await supabase.rpc("assumir_caso_fidelizacao_vencida", {
        p_aluno_id: alunoId,
        p_motivo: m,
      });
      const r = Array.isArray(data) ? data[0] : data;
      if (error) {
        setAviso({ tipo: "erro", texto: MSG_FALHA });
      } else if (!r?.sucesso) {
        setAviso({ tipo: "erro", texto: r?.mensagem || MSG_INDISPONIVEL });
      } else {
        setAviso({ tipo: "ok", texto: r.mensagem || "Caso assumido por você." });
        setMotivo("");
        onAssumido?.();
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 12, margin: "8px 0" }}>
      <strong>Assumir caso disponível</strong>
      <p style={{ margin: "4px 0 8px", fontSize: 13 }}>
        Este aluno está com outro operador. Se o prazo de fidelização tiver vencido, o caso passa para você.
        A fidelização de 10 dias começa no seu primeiro acionamento válido.
        Casos fidelizados pelo giro de carteira não entram nesta ação nesta versão.
      </p>
      <label style={{ display: "block", fontSize: 13 }}>
        Motivo (obrigatório)
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          maxLength={300}
          style={{ display: "block", width: "100%", marginTop: 4 }}
          placeholder="Ex.: aluno pediu atendimento; colega sem acionamento há 11 dias"
        />
      </label>
      <button type="button" onClick={assumir} disabled={enviando || !motivo.trim()} style={{ marginTop: 8 }}>
        {enviando ? "Assumindo..." : "Assumir caso disponível"}
      </button>
      {aviso && (
        <p role="status" style={{ marginTop: 8, fontSize: 13, color: aviso.tipo === "ok" ? "#1a7f37" : "#b42318" }}>
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
