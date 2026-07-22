import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function MinhaCarteira({ usuarioLogado }) {
  const [resumo, setResumo] = useState(null);

  useEffect(() => {
    if (!usuarioLogado?.email) return;

    async function carregar() {
      const { data } = await supabase.rpc("resumo_carteira_operador", {
        p_email: usuarioLogado.email,
      });
      setResumo(data?.[0] || null);
    }

    carregar();
  }, [usuarioLogado?.email]);

  if (!resumo || Number(resumo.qtd_alunos) === 0) return null;

  return (
    <div style={estilos.caixa}>
      <strong style={{ fontSize: 14 }}>📁 Minha carteira</strong>
      <div style={estilos.grade}>
        <div style={estilos.item}>
          <div style={estilos.numero}>{resumo.qtd_alunos}</div>
          <div style={estilos.label}>Alunos vinculados</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#fcd34d" }}>
            {moeda(resumo.valor_em_aberto)}
          </div>
          <div style={estilos.label}>Total em aberto</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#7dd3fc" }}>
            {moeda(resumo.valor_a_vencer)}
          </div>
          <div style={estilos.label}>A vencer</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#fca5a5" }}>
            {moeda(resumo.valor_vencido)}
          </div>
          <div style={estilos.label}>Vencido</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#93c5fd" }}>{resumo.qtd_negociados}</div>
          <div style={estilos.label}>Negociados (acordo fechado)</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#34d399" }}>
            {moeda(resumo.valor_pago_mes)}
          </div>
          <div style={estilos.label}>Pago no mês (projeção)</div>
        </div>
        <div style={estilos.item}>
          <div style={{ ...estilos.numero, color: "#60a5fa" }}>
            {moeda(resumo.honorario_mes)}
          </div>
          <div style={estilos.label}>Honorário no mês</div>
        </div>
      </div>
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(148,163,184,0.05)",
    border: "1px solid rgba(148,163,184,0.2)",
  },
  grade: {
    display: "flex",
    gap: 24,
    flexWrap: "wrap",
    marginTop: 8,
  },
  item: {
    minWidth: 100,
  },
  numero: {
    fontSize: 18,
    fontWeight: 800,
  },
  label: {
    fontSize: 11,
    opacity: 0.75,
    marginTop: 2,
  },
};
