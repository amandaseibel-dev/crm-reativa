// Diagnóstico de cobertura do portador 166 no espelho Prime.
//
// POR QUE EXISTE. O espelho prime_extrato, alimentado pela prime-extrato, tem
// zero linhas de portador 166 para os 10.971 CPFs identificados nesse portador.
// A hipótese é que o composite /students/{reg} não devolve o portador 166 --
// somente /students/{reg}/financial-statement devolveria. Esta tela confirma
// isso para uma única matrícula auditada, sem reprocessar filas.
//
// O QUE MOSTRA. Somente: se o endpoint respondeu, quantos registros por
// portador, e se o 166 está presente. Nenhum CPF, boleto, data ou valor
// individual é exibido.
//
// ACESSO. A rota é protegida no App.jsx pela mesma lista de e-mails que
// usuario_e_gestao() usa no banco. A prime-sonda faz a verificação de novo no
// servidor -- duas camadas independentes.
//
// NÃO ALTERA NADA. Não grava, não altera fila, não dispara cron.

import { useState } from "react";
import { supabase } from "../services/supabase";

// Matrícula previamente auditada como pertencente ao portador 166.
// Definida aqui: a gestora não precisa digitar nada.
const MATRICULA_PILOTO = "2025007862";
const CAMINHO_SONDA = `/students/${MATRICULA_PILOTO}/financial-statement`;

export default function DiagnosticoPortador166() {
  const [estado, setEstado] = useState("idle"); // idle | carregando | ok | erro
  const [resultado, setResultado] = useState(null);

  async function executar() {
    setEstado("carregando");
    setResultado(null);

    // supabase.functions.invoke envia o JWT da sessão autenticada automaticamente.
    // Nenhum token é manipulado aqui.
    const { data, error } = await supabase.functions.invoke("prime-sonda", {
      body: { caminho: CAMINHO_SONDA, cru: true },
    });

    // Erro retornado pela Edge Function (autenticação, indisponibilidade, etc.)
    if (error) {
      setEstado("erro");
      const msg = error.message ?? String(error);
      // Distingue autenticação de outros erros pelo texto da mensagem
      const tipoErro = msg.includes("ACESSO_NEGADO") || msg.includes("403")
        ? "AUTENTICACAO_NEGADA"
        : msg.includes("401")
        ? "SEM_AUTENTICACAO"
        : "ERRO_FUNCAO";
      setResultado({ tipo: tipoErro, mensagem: msg });
      return;
    }

    // A prime-sonda pode devolver erro da API do Prime no campo `data.status`
    // mesmo com HTTP 200 na chamada da Edge Function.
    const statusPrime = data?.status ?? null;
    if (statusPrime !== null && statusPrime !== 200) {
      setEstado("erro");
      setResultado({
        tipo: statusPrime === 401 || statusPrime === 403
          ? "AUTENTICACAO_PRIME_NEGADA"
          : "INDISPONIBILIDADE_PRIME",
        mensagem: `API Prime respondeu com status ${statusPrime}`,
        status_prime: statusPrime,
      });
      return;
    }

    // cru contém os dados brutos do Prime -- array ou {items:[...]}
    const cru = data?.cru ?? null;
    const linhas = Array.isArray(cru)
      ? cru
      : Array.isArray(cru?.items)
      ? cru.items
      : null;

    if (linhas === null) {
      setEstado("erro");
      setResultado({
        tipo: "FORMATO_INESPERADO",
        mensagem: "A API respondeu mas os dados não estão no formato de lista esperado.",
        forma_recebida: cru === null ? "null" : typeof cru,
        campos_no_topo: cru && typeof cru === "object" ? Object.keys(cru).join(", ") : "—",
      });
      return;
    }

    // Contagem por portador -- sem expor boleto, CPF ou valor
    const contagem = {};
    for (const l of linhas) {
      const id = l?.carrier?.id ?? "sem_portador";
      contagem[id] = (contagem[id] ?? 0) + 1;
    }

    setEstado("ok");
    setResultado({
      total: linhas.length,
      por_portador: contagem,
      tem_166: 166 in contagem,
      matricula: MATRICULA_PILOTO,
    });
  }

  return (
    <div style={{ maxWidth: 580, margin: "40px auto", padding: "0 16px", fontFamily: "'Sora','Inter',system-ui,sans-serif" }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, color: "var(--rv-tinta)", marginBottom: 4 }}>
        Diagnóstico — Portador 166
      </h1>
      <p style={{ fontSize: 13, color: "var(--rv-texto-suave)", marginBottom: 24, lineHeight: 1.5 }}>
        Consulta de leitura à <code>prime-sonda</code> para a matrícula{" "}
        <strong>{MATRICULA_PILOTO}</strong>. Mostra somente quantidade de
        registros por portador e se o 166 está presente. Não altera dados nem
        processa filas.
      </p>

      <button
        onClick={executar}
        disabled={estado === "carregando"}
        style={{
          background: estado === "carregando" ? "#94a3b8" : "#1d4ed8",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "10px 22px",
          fontWeight: 700,
          fontSize: 14,
          cursor: estado === "carregando" ? "not-allowed" : "pointer",
        }}
      >
        {estado === "carregando" ? "Consultando…" : "Executar diagnóstico"}
      </button>

      {resultado && estado === "ok" && (
        <div
          role="region"
          aria-label="Resultado do diagnóstico"
          style={{ marginTop: 24, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: 20 }}
        >
          <div style={{ fontWeight: 700, color: "#15803d", marginBottom: 12, fontSize: 15 }}>
            ✓ Endpoint respondeu com sucesso
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              <tr>
                <td style={{ padding: "4px 0", color: "#374151" }}>Total de registros</td>
                <td style={{ padding: "4px 0", fontWeight: 700, textAlign: "right" }}>
                  {resultado.total}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "4px 0", color: "#374151" }}>Portador 166 presente?</td>
                <td
                  style={{
                    padding: "4px 0",
                    fontWeight: 800,
                    textAlign: "right",
                    color: resultado.tem_166 ? "#15803d" : "#b91c1c",
                  }}
                >
                  {resultado.tem_166 ? "✓ SIM" : "✗ NÃO"}
                </td>
              </tr>
              {Object.entries(resultado.por_portador).length > 0 && (
                <tr>
                  <td colSpan={2} style={{ padding: "10px 0 4px", color: "#6b7280", fontSize: 12, fontWeight: 600 }}>
                    REGISTROS POR PORTADOR
                  </td>
                </tr>
              )}
              {Object.entries(resultado.por_portador)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([id, qtd]) => (
                  <tr key={id}>
                    <td style={{ padding: "2px 0 2px 12px", color: "#374151" }}>
                      Portador {id}
                    </td>
                    <td style={{ padding: "2px 0", fontWeight: 600, textAlign: "right" }}>
                      {qtd} registro{qtd !== 1 ? "s" : ""}
                    </td>
                  </tr>
                ))}
              {resultado.total === 0 && (
                <tr>
                  <td colSpan={2} style={{ padding: "8px 0", color: "#92400e", fontSize: 13 }}>
                    O endpoint respondeu com lista vazia — portador 166 ausente na
                    API para esta matrícula.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {resultado && estado === "erro" && (
        <div
          role="alert"
          style={{ marginTop: 24, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: 20 }}
        >
          <div style={{ fontWeight: 700, color: "#b91c1c", marginBottom: 8, fontSize: 15 }}>
            ✗ {resultado.tipo.replace(/_/g, " ")}
          </div>
          <div style={{ fontSize: 13, color: "#7f1d1d", lineHeight: 1.5 }}>
            {resultado.mensagem}
          </div>
          {resultado.campos_no_topo && (
            <div style={{ fontSize: 12, color: "#991b1b", marginTop: 8 }}>
              Campos no topo da resposta: {resultado.campos_no_topo}
            </div>
          )}
          {resultado.status_prime && (
            <div style={{ fontSize: 12, color: "#991b1b", marginTop: 4 }}>
              Status HTTP da API Prime: {resultado.status_prime}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
