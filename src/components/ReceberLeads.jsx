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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong style={estilos.titulo}>🎯 Receber leads</strong>
          <p style={estilos.subtitulo}>
            Puxa casos sem responsável até você ficar com o mesmo nível de valor em
            cobrança dos colegas.
          </p>
        </div>
        <button type="button" onClick={receberLeads} disabled={processando} style={estilos.botao}>
          {processando ? "Buscando..." : "Receber leads"}
        </button>
      </div>

      {resultado && (
        <p style={estilos.mensagem}>
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

// Paleta clara e neutra, alinhada ao PainelCarteira. Somente aparencia.
const estilos = {
  caixa: {
    padding: "14px 16px",
    marginBottom: 14,
    borderRadius: 12,
    background: "#fff",
    border: "1px solid #eef2f6",
    boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
  },
  titulo: {
    fontSize: 14,
    fontWeight: 600,
    color: "#1e293b",
  },
  subtitulo: {
    fontSize: 12,
    color: "#94a3b8",
    margin: "3px 0 0",
    maxWidth: 420,
    lineHeight: 1.5,
  },
  botao: {
    padding: "9px 16px",
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  mensagem: {
    marginTop: 10,
    fontSize: 12.5,
    color: "#475569",
  },
};
