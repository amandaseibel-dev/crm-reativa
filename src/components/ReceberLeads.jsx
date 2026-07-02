import { useState } from "react";
import { supabase } from "../services/supabase";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function ReceberLeads({ usuarioLogado, aoReceber }) {
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState(null);

  async function receberLeads() {
    if (!usuarioLogado?.email) return;

    setProcessando(true);
    setResultado(null);

    try {
      const { data, error } = await supabase.rpc("receber_leads", {
        p_email: usuarioLogado.email,
        p_nome: usuarioLogado.nome || usuarioLogado.email,
      });

      if (error) {
        setResultado({ erro: "Não consegui puxar leads agora. Tenta de novo." });
        return;
      }

      const linha = data?.[0];
      setResultado({
        qtd: linha?.alunos_atribuidos || 0,
        valor: linha?.valor_atribuido || 0,
      });

      if ((linha?.alunos_atribuidos || 0) > 0 && aoReceber) {
        aoReceber();
      }
    } finally {
      setProcessando(false);
    }
  }

  return (
    <div style={estilos.caixa}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <strong style={{ fontSize: 14 }}>🎯 Receber leads</strong>
          <p style={{ fontSize: 12, opacity: 0.75, margin: "2px 0 0" }}>
            Puxa casos sem responsável até você ficar com o mesmo nível de valor em
            cobrança dos colegas.
          </p>
        </div>
        <button type="button" onClick={receberLeads} disabled={processando} style={estilos.botao}>
          {processando ? "Buscando..." : "Receber leads"}
        </button>
      </div>

      {resultado && (
        <p style={{ marginTop: 8, fontSize: 13 }}>
          {resultado.erro
            ? resultado.erro
            : resultado.qtd === 0
            ? "Você já está no mesmo nível dos colegas — nenhum lead novo agora."
            : `Você recebeu ${resultado.qtd} caso(s) novo(s), totalizando ${moeda(resultado.valor)} em cobrança.`}
        </p>
      )}
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(168,85,247,0.06)",
    border: "1px solid rgba(168,85,247,0.25)",
  },
  botao: {
    padding: "8px 16px",
    borderRadius: 8,
    border: "1px solid rgba(168,85,247,0.6)",
    background: "rgba(168,85,247,0.16)",
    color: "#d8b4fe",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
