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
import { resumirProvarMatch } from "../utils/diagnosticoAcordos";

// Matrícula previamente auditada como pertencente ao portador 166.
// Definida aqui: a gestora não precisa digitar nada.
const MATRICULA_PILOTO = "2025007862";
const CAMINHO_SONDA = `/students/${MATRICULA_PILOTO}/financial-statement`;

// ---------------------------------------------------------------------------
// DIAGNÓSTICO DE ACORDOS — `prime-sync`, ação `provar_match`
//
// POR QUE EXISTE. A pergunta aberta da Etapa 0 é se
// `/students/{reg}/agreements` passou a devolver acordo com a LISTA DE
// PARCELAS, inclusive as não pagas. O último teste foi em 15/09/2026, e sem
// essa resposta a sincronização automática de acordos não sai do lugar.
// Ver docs/integracoes/prime-acordos-contrato-sincronizacao.md.
//
// POR QUE AQUI. A ação já existe publicada e é SOMENTE LEITURA (dois GET na
// API e dois SELECT; nenhum insert/update/upsert/delete/rpc). Faltava apenas
// uma porta autorizada para acioná-la: `supabase.functions.invoke` manda o JWT
// da sessão de gestão automaticamente, e o portão da função confere
// `usuario_e_gestao()` no servidor. Nenhum token é manipulado nesta tela.
//
// O QUE NÃO FAZ. Não grava, não altera importação, acordo, pagamento ou baixa,
// não dispara cron, não cria credencial.
const AMOSTRA_ACORDOS = 5;

export default function DiagnosticoPortador166() {
  const [estado, setEstado] = useState("idle"); // idle | carregando | ok | erro
  const [resultado, setResultado] = useState(null);
  const [estadoAcordos, setEstadoAcordos] = useState("idle");
  const [resumoAcordos, setResumoAcordos] = useState(null);
  const [erroAcordos, setErroAcordos] = useState(null);

  async function executarDiagnosticoAcordos() {
    setEstadoAcordos("carregando");
    setResumoAcordos(null);
    setErroAcordos(null);

    // Mesmo padrão da sonda acima: o invoke envia o JWT da sessão autenticada.
    // Nenhum token é lido, digitado ou exibido aqui.
    const { data, error } = await supabase.functions.invoke("prime-sync", {
      body: { acao: "provar_match", amostra: AMOSTRA_ACORDOS },
    });

    if (error || data?.erro) {
      setEstadoAcordos("erro");
      setErroAcordos(String(error?.message ?? data?.erro));
      return;
    }

    setEstadoAcordos("ok");
    setResumoAcordos(resumirProvarMatch(data?.relatorio));
  }

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

      {/* --------------------------------------------------------------- */}
      {/* DIAGNÓSTICO DE ACORDOS — prime-sync / provar_match              */}
      {/* --------------------------------------------------------------- */}
      <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid #e5e7eb" }}>
        <h2 style={{ fontSize: 15, fontWeight: 800, color: "var(--rv-tinta)", marginBottom: 4 }}>
          Diagnóstico — estrutura dos acordos
        </h2>
        <p style={{ fontSize: 13, color: "var(--rv-texto-suave)", marginBottom: 16, lineHeight: 1.5 }}>
          Consulta de leitura à <code>prime-sync</code> (<code>provar_match</code>),
          com amostra de <strong>{AMOSTRA_ACORDOS}</strong> alunos do portador
          166 escolhidos pela própria função. Responde se{" "}
          <code>/students/&#123;reg&#125;/agreements</code> devolve acordo com
          lista de parcelas. Mostra somente números e nomes de campo — nenhum
          CPF, matrícula, nome ou valor individual.
        </p>

        <button
          onClick={executarDiagnosticoAcordos}
          disabled={estadoAcordos === "carregando"}
          style={{
            background: estadoAcordos === "carregando" ? "#94a3b8" : "#7c3aed",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "10px 22px",
            fontWeight: 700,
            fontSize: 14,
            cursor: estadoAcordos === "carregando" ? "not-allowed" : "pointer",
          }}
        >
          {estadoAcordos === "carregando" ? "Consultando…" : "Diagnosticar acordos"}
        </button>

        {resumoAcordos && estadoAcordos === "ok" && (
          <div
            role="region"
            aria-label="Resultado do diagnóstico de acordos"
            style={{
              marginTop: 20,
              background: resumoAcordos.acordos_encontrados > 0 ? "#f0fdf4" : "#fffbeb",
              border: `1px solid ${resumoAcordos.acordos_encontrados > 0 ? "#86efac" : "#fcd34d"}`,
              borderRadius: 10,
              padding: 20,
            }}
          >
            <div
              style={{
                fontWeight: 700,
                marginBottom: 12,
                fontSize: 15,
                color: resumoAcordos.acordos_encontrados > 0 ? "#15803d" : "#92400e",
              }}
            >
              {resumoAcordos.acordos_encontrados > 0
                ? "✓ A API devolveu acordos"
                : "✗ A API não devolveu acordo nenhum"}
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <tbody>
                <tr>
                  <td style={{ padding: "4px 0", color: "#374151" }}>Consultas realizadas</td>
                  <td style={{ padding: "4px 0", fontWeight: 700, textAlign: "right" }}>
                    {resumoAcordos.consultas}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "4px 0", color: "#374151" }}>Alunos com acordo retornado</td>
                  <td style={{ padding: "4px 0", fontWeight: 700, textAlign: "right" }}>
                    {resumoAcordos.com_acordo}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "4px 0", color: "#374151" }}>Acordos encontrados</td>
                  <td style={{ padding: "4px 0", fontWeight: 800, textAlign: "right" }}>
                    {resumoAcordos.acordos_encontrados}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "4px 0", color: "#374151" }}>Documentos de parcela na API</td>
                  <td style={{ padding: "4px 0", fontWeight: 700, textAlign: "right" }}>
                    {resumoAcordos.docs_prime}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "4px 0", color: "#374151" }}>Desses, já existentes no CRM</td>
                  <td style={{ padding: "4px 0", fontWeight: 700, textAlign: "right" }}>
                    {resumoAcordos.docs_casados}
                  </td>
                </tr>

                <tr>
                  <td colSpan={2} style={{ padding: "12px 0 4px", color: "#6b7280", fontSize: 12, fontWeight: 600 }}>
                    PARCELAS
                  </td>
                </tr>
                {resumoAcordos.situacao_conhecida ? (
                  <>
                    <tr>
                      <td style={{ padding: "2px 0 2px 12px", color: "#374151" }}>Pagas</td>
                      <td style={{ padding: "2px 0", fontWeight: 700, textAlign: "right" }}>
                        {resumoAcordos.parcelas_pagas}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 0 2px 12px", color: "#374151" }}>Não pagas</td>
                      <td
                        style={{
                          padding: "2px 0",
                          fontWeight: 800,
                          textAlign: "right",
                          color: resumoAcordos.parcelas_nao_pagas > 0 ? "#15803d" : "#374151",
                        }}
                      >
                        {resumoAcordos.parcelas_nao_pagas}
                      </td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td colSpan={2} style={{ padding: "4px 0 4px 12px", color: "#92400e", fontSize: 13 }}>
                      A resposta não trouxe campo de situação de parcela — não é
                      possível dizer se há parcela não paga. Isto é diferente de
                      &quot;não há parcela não paga&quot;.
                    </td>
                  </tr>
                )}

                <tr>
                  <td colSpan={2} style={{ padding: "12px 0 4px", color: "#6b7280", fontSize: 12, fontWeight: 600 }}>
                    CAMPOS RETORNADOS NO ACORDO ({resumoAcordos.campos.length})
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} style={{ padding: "2px 0 2px 12px", color: "#374151", fontSize: 13, wordBreak: "break-word" }}>
                    {resumoAcordos.campos.length > 0 ? (
                      <code>{resumoAcordos.campos.join(", ")}</code>
                    ) : (
                      "— nenhum campo (a API devolveu lista vazia)"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {erroAcordos && estadoAcordos === "erro" && (
          <div
            role="alert"
            style={{ marginTop: 20, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: 20 }}
          >
            <div style={{ fontWeight: 700, color: "#b91c1c", marginBottom: 6, fontSize: 14 }}>
              A consulta não foi concluída
            </div>
            <div style={{ fontSize: 13, color: "#7f1d1d" }}>{erroAcordos}</div>
            <div style={{ fontSize: 12, color: "#991b1b", marginTop: 8 }}>
              <code>Somente gestao</code> ou <code>403</code> indica que a sessão
              atual não passa no portão de gestão do servidor — o impedimento
              passa a ser de perfil, não de mecanismo.
            </div>
          </div>
        )}
      </div>

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
