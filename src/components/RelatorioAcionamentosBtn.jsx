import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

function esc(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export default function RelatorioAcionamentosBtn({ aluno }) {
  const [email, setEmail] = useState("");
  const [gerando, setGerando] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data?.user?.email || ""));
  }, []);

  if (!podeVerTudo(email)) return null;

  async function gerar() {
    if (!aluno?.id) return;
    setGerando(true);
    try {
      const { data, error } = await supabase.rpc("relatorio_acionamentos_aluno", { p_aluno_id: String(aluno.id) });
      if (error) { alert("Erro ao gerar: " + error.message); return; }
      const a = (data && data.aluno) || {};
      const lista = (data && data.acionamentos) || [];
      const hoje = new Date().toLocaleString("pt-BR");
      const linhas = lista.map((x) =>
        "<tr><td>" + esc(x.data) + "</td><td>" + esc(x.tipo) + "</td><td>" + esc(x.operador) + "</td><td>" + esc(x.descricao) + "</td></tr>"
      ).join("");
      const html =
        "<html><head><meta charset='utf-8'><title>Acionamentos - " + esc(a.nome || "") + "</title>" +
        "<style>body{font-family:Arial,sans-serif;color:#111;margin:28px;}" +
        "h1{font-size:18px;margin:0 0 4px;color:#1d4ed8;}" +
        ".sub{color:#555;font-size:12px;margin-bottom:16px;}" +
        ".info{font-size:13px;margin:10px 0 4px;}" +
        ".info b{color:#000;}" +
        "table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px;}" +
        "th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top;}" +
        "th{background:#f1f5f9;}" +
        ".tot{margin:12px 0;font-size:13px;font-weight:bold;}" +
        ".rod{margin-top:24px;color:#888;font-size:11px;border-top:1px solid #eee;padding-top:8px;}" +
        "</style></head><body>" +
        "<h1>Relatorio de Acionamentos</h1>" +
        "<div class='sub'>ReATIVA - Recuperacao ULBRA</div>" +
        "<div class='info'><b>Aluno:</b> " + esc(a.nome || "-") + "</div>" +
        "<div class='info'><b>CPF:</b> " + esc(a.cpf || "-") + " &nbsp; <b>Unidade:</b> " + esc(a.unidade || "-") + "</div>" +
        "<div class='info'><b>Telefone:</b> " + esc(a.telefone || "-") + " &nbsp; <b>E-mail:</b> " + esc(a.email || "-") + "</div>" +
        "<div class='tot'>Total de acionamentos: " + ((data && data.total) || 0) + "</div>" +
        "<table><thead><tr><th>Data</th><th>Tipo</th><th>Operador</th><th>Descricao</th></tr></thead><tbody>" +
        (linhas || "<tr><td colspan='4'>Nenhum acionamento registrado.</td></tr>") +
        "</tbody></table>" +
        "<div class='rod'>Gerado em " + esc(hoje) + " por " + esc(email) + " - documento interno confidencial.</div>" +
        "</body></html>";
      const w = window.open("", "_blank");
      if (!w) { alert("Permita pop-ups para gerar o PDF."); return; }
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 500);
    } finally {
      setGerando(false);
    }
  }

  return (
    <button style={S.btn} onClick={gerar} disabled={gerando} title="Gera PDF via impressao">
      {gerando ? "Gerando..." : "PDF de acionamentos"}
    </button>
  );
}

const S = {
  btn: { background: "#fff", color: "#1d4ed8", border: "1px solid #1d4ed8", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", fontSize: 13, marginTop: 10 },
};
