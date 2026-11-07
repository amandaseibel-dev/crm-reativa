import { useState } from "react";
import { supabase } from "../services/supabase";

// Ação TEMPORÁRIA de diagnóstico, só para a gestão: mostra o que o TOKEN DE
// BACKEND alcança na Mensageria ULBRA — escopos, limites e nomes de
// ferramentas. É o que decide o desenho da integração operacional.
//
// Usa a sessão já autenticada do app, exatamente como `BlocoUlbra` faz:
// `supabase.auth.getSession()` e `fetch` na Edge Function. Nenhuma credencial
// é lida, digitada ou exibida aqui — nem a do Supabase, nem a da Mensageria.
// A função do outro lado é só leitura, não grava nada e já recusa quem não é
// gestão; o portão abaixo evita que a tela apareça para quem levaria 403.
const PERFIS_GESTAO = ["gerencia", "administrativo"];

const S = {
  caixa: { padding: 24, maxWidth: 980, margin: "0 auto" },
  cartao: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, marginTop: 16, background: "#fff" },
  botao: { padding: "10px 18px", borderRadius: 8, border: 0, background: "#2563eb", color: "#fff", cursor: "pointer", fontWeight: 600 },
  chip: { display: "inline-block", border: "1px solid #d1d5db", borderRadius: 999, padding: "2px 10px", margin: "3px 4px 3px 0", fontSize: 13, fontFamily: "monospace" },
  erro: { marginTop: 16, padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },
  rotulo: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "#6b7280", marginBottom: 6 },
  td: { padding: "6px 10px", borderBottom: "1px solid #f3f4f6", fontSize: 14 },
};

export default function UlbraDiagnostico({ usuario }) {
  const perfil = usuario?.perfil?.perfil;
  const [estado, setEstado] = useState("ocioso");
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);

  if (perfil && !PERFIS_GESTAO.includes(perfil)) {
    return <div style={S.caixa}>Esta tela é restrita à gestão.</div>;
  }

  const executar = async () => {
    setEstado("carregando");
    setErro(null);
    setDados(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setErro("Sessão não encontrada. Faça login novamente.");
        setEstado("erro");
        return;
      }
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-diagnostico`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: "{}",
        },
      );
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setErro(
          [json?.erro ?? `HTTP ${resp.status}`, json?.detalhe, json?.motivo]
            .filter(Boolean)
            .join(" · "),
        );
        setEstado("erro");
        return;
      }
      setDados(json);
      setEstado("pronto");
    } catch {
      setErro("Falha de rede ao chamar a função.");
      setEstado("erro");
    }
  };

  const limites = dados?.acesso?.limites ?? {};

  return (
    <div style={S.caixa}>
      <h1 style={{ margin: 0, fontSize: 22 }}>Diagnóstico da Mensageria ULBRA</h1>
      <p style={{ color: "#6b7280", marginTop: 6 }}>
        Mostra o que a <strong>credencial de backend</strong> alcança: escopos, limites e
        ferramentas. Só leitura — nada é gravado, e nenhuma credencial aparece aqui.
      </p>

      <button type="button" style={S.botao} onClick={executar} disabled={estado === "carregando"}>
        {estado === "carregando" ? "Consultando…" : "Executar diagnóstico"}
      </button>

      {estado === "erro" && <div style={S.erro}>{erro}</div>}

      {estado === "pronto" && dados && (
        <>
          <div style={S.cartao}>
            <div style={S.rotulo}>Conexão</div>
            <div style={{ fontSize: 15 }}>
              tipo: <strong>{dados.acesso?.conexao_tipo ?? "não informado"}</strong>
              {dados.acesso?.perfis?.length > 0 && (
                <> · perfis: {dados.acesso.perfis.map((p) => <span key={p} style={S.chip}>{p}</span>)}</>
              )}
            </div>
          </div>

          <div style={S.cartao}>
            <div style={S.rotulo}>Escopos ({dados.acesso?.escopos?.length ?? 0})</div>
            {(dados.acesso?.escopos ?? []).map((e) => <span key={e} style={S.chip}>{e}</span>)}
          </div>

          <div style={S.cartao}>
            <div style={S.rotulo}>Limites</div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                {Object.entries(limites).map(([nome, v]) => (
                  <tr key={nome}>
                    <td style={{ ...S.td, fontFamily: "monospace" }}>{nome}</td>
                    <td style={S.td}>
                      {v && typeof v === "object"
                        ? Object.entries(v).map(([k, n]) => `${k}: ${n}`).join(" · ")
                        : String(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={S.cartao}>
            <div style={S.rotulo}>Ferramentas ({dados.total_ferramentas ?? 0})</div>
            {(dados.ferramentas ?? []).map((f) => <span key={f} style={S.chip}>{f}</span>)}
          </div>
        </>
      )}
    </div>
  );
}
