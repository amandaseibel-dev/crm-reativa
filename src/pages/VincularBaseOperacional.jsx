import { useState } from "react";
import { supabase } from "../services/supabase";

const OPERADORES_ALVO = [
  "cobranca03@aelbra.com.br",
  "cobranca05@aelbra.com.br",
  "cobranca06@aelbra.com.br",
  "cobranca08@aelbra.com.br",
  "cobranca10@aelbra.com.br",
  "cobranca11@aelbra.com.br",
  "cobranca12@aelbra.com.br",
  "cobranca13@aelbra.com.br",
];

export default function VincularBaseOperacional() {
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState("");

  async function redistribuirCarteira() {
    const confirmado = window.confirm(
      `Isso vai soltar TODOS os casos atuais dos ${OPERADORES_ALVO.length} operadores e redistribuir 500 casos novos pra cada um, priorizando valor mais alto e casos ainda sem acionamento. Essa ação não pode ser desfeita automaticamente. Confirma?`
    );
    if (!confirmado) return;

    setProcessando(true);
    setErro("");
    setResultado(null);

    try {
      const { data, error } = await supabase.rpc("redistribuir_casos_operadores");

      if (error) {
        setErro(error.message || String(error));
        return;
      }

      setResultado(data || []);
    } catch (err) {
      console.error(err);
      setErro("Erro ao redistribuir: " + (err?.message || String(err)));
    } finally {
      setProcessando(false);
    }
  }

  const totalCasos = resultado ? resultado.reduce((acc, r) => acc + r.casos_atribuidos, 0) : 0;
  const totalValor = resultado
    ? resultado.reduce((acc, r) => acc + Number(r.valor_total || 0), 0)
    : 0;

  return (
    <div className="main">
      <h1>Redistribuir carteira dos operadores</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Solta todos os casos que estão hoje com os {OPERADORES_ALVO.length} operadores e distribui
        500 casos novos pra cada um, equilibrando quantidade e valor entre eles. Prioriza casos de
        maior valor e os que ainda não tiveram nenhum acionamento. Casos quitados, com acordo
        fechado, cancelados ou marcados como "não acionar" ficam de fora do pool.
      </p>

      <div style={estilos.caixaUpload}>
        <button
          type="button"
          onClick={redistribuirCarteira}
          disabled={processando}
          style={estilos.botaoConfirmar}
        >
          {processando ? "Redistribuindo..." : "🔄 Redistribuir carteira agora"}
        </button>
      </div>

      {erro && <p style={{ color: "#f87171", marginTop: 12 }}>{erro}</p>}

      {resultado && (
        <div style={{ marginTop: 20 }}>
          <div style={estilos.caixaSucesso}>
            <strong>Redistribuição concluída.</strong>
            <p style={{ margin: "6px 0 0" }}>
              {totalCasos} casos distribuídos, totalizando{" "}
              {totalValor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.
            </p>
          </div>

          <div style={{ ...estilos.grade, marginTop: 16 }}>
            {resultado.map((r) => (
              <div key={r.operador_email} style={estilos.cartao}>
                <div style={estilos.numero}>{r.casos_atribuidos}</div>
                <div style={estilos.label}>{r.operador_nome}</div>
                <div style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>
                  {Number(r.valor_total || 0).toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  caixaUpload: {
    padding: 20,
    borderRadius: 10,
    border: "1px dashed rgba(148,163,184,0.4)",
    background: "rgba(148,163,184,0.05)",
  },
  caixaSucesso: {
    marginTop: 16,
    padding: "12px 16px",
    borderRadius: 10,
    background: "rgba(34,197,94,0.1)",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: {
    fontSize: 22,
    fontWeight: 800,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    marginTop: 4,
  },
  botaoConfirmar: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(34,197,94,0.6)",
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
  },
};
