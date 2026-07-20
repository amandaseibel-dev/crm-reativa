import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

// Mesma lista de operadores usada na ficha do aluno (Aluno.jsx).
const OPERADORES_REATIVA = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Maurício", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];

/**
 * Alteração do operador responsável — reutilizável em qualquer tela que abra
 * um aluno/caso (ficha, painel, modal). NÃO faz UPDATE direto (isso é barrado
 * pela trava _guard_resp_aluno): chama a RPC master `alterar_responsavel_aluno`,
 * que valida permissão no banco (internal.pode_alterar_responsavel), registra
 * histórico e mantém `alunos` + `casos` coerentes.
 *
 * Props:
 *   aluno       -> registro do aluno/caso (precisa de id uuid)
 *   origem      -> string p/ auditoria (ex.: "ficha_aluno", "crm"); default "ficha_aluno"
 *   onAlterado  -> callback opcional após sucesso
 */
export default function AlterarOperadorResponsavel({
  aluno,
  origem = "ficha_aluno",
  onAlterado,
}) {
  const [emailUsuario, setEmailUsuario] = useState("");
  const [novoOperadorEmail, setNovoOperadorEmail] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmailUsuario(data?.user?.email || "");
    });
  }, []);

  // Espelho da permissão master no front (o banco valida de novo na RPC).
  // Demais perfis não veem nada.
  if (!podeVerTudo(emailUsuario)) return null;

  async function alterar() {
    if (!aluno?.id) {
      alert("Selecione um aluno antes de alterar o operador.");
      return;
    }
    if (!novoOperadorEmail) {
      alert("Selecione o novo operador responsável.");
      return;
    }
    const motivoLimpo = motivo.trim();
    if (false) {
      alert("Informe o motivo da alteração.");
      return;
    }

    setSalvando(true);
    try {
      const { data, error } = await supabase.rpc("alterar_responsavel_aluno", {
        p_aluno_id: aluno.id,
        p_novo_email: novoOperadorEmail,
        p_motivo: motivoLimpo,
        p_origem: origem,
        p_modo: "ALTERAR_SOMENTE_ALUNO",
        p_acordo_ids: [],
      });

      if (error) {
        alert("Erro ao alterar operador: " + error.message);
        return;
      }
      if (!data?.ok) {
        const traducao = {
          SEM_PERMISSAO: "Você não tem permissão para alterar o responsável.",
          MOTIVO_OBRIGATORIO: "Informe o motivo da alteração.",
          NOVO_RESPONSAVEL_INVALIDO: "Operador de destino inválido.",
          ALUNO_NAO_ENCONTRADO: "Aluno não encontrado.",
          NAO_AUTENTICADO: "Sessão expirada, faça login novamente.",
        };
        alert(traducao[data?.erro] || "Não foi possível alterar: " + (data?.erro || "erro desconhecido"));
        return;
      }

      alert("Operador responsável alterado com sucesso.");
      setNovoOperadorEmail("");
      setMotivo("");
      if (onAlterado) onAlterado(data);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div style={caixaInterna}>
      <h3 style={tituloSecao}>Alterar operador responsável</h3>

      <label style={label}>Novo operador</label>
      <select
        value={novoOperadorEmail}
        onChange={(e) => setNovoOperadorEmail(e.target.value)}
        style={select}
      >
        <option value="">Selecione...</option>
        {OPERADORES_REATIVA.map((op) => (
          <option key={op.email} value={op.email}>
            {op.nome}
          </option>
        ))}
      </select>

      <label style={label}>Motivo</label>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        style={textarea}
        placeholder="Descreva o motivo da alteração de responsável."
      />

      <button type="button" onClick={alterar} disabled={salvando} style={botaoPrincipal}>
        {salvando ? "Alterando..." : "Alterar operador"}
      </button>
    </div>
  );
}

const caixaInterna = {
  background: "#111827",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "16px",
  marginTop: "12px",
};
const tituloSecao = { margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: "#f3f4f6" };
const label = { display: "block", fontSize: "12px", fontWeight: 600, color: "#9ca3af", margin: "10px 0 4px" };
const select = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid #374151",
  background: "#1f2937",
  color: "#f3f4f6",
  boxSizing: "border-box",
};
const textarea = { ...select, minHeight: "70px", resize: "vertical" };
const botaoPrincipal = {
  marginTop: "14px",
  padding: "10px 18px",
  borderRadius: "8px",
  border: "none",
  background: "#3b82f6",
  color: "#052e16",
  fontWeight: 700,
  cursor: "pointer",
};
