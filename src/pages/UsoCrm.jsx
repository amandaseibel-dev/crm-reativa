import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

// Tela "Uso do CRM" — exclusiva para a gestão.
//
// Mostra rotas com total de acessos e usuários distintos nos últimos 30 dias,
// ordenadas pelo total de acessos (maior primeiro).
//
// FONTE: RPC `uso_telas_por_rota()` — security definer, verifica
// `usuario_e_gestao()` internamente e retorna vazio para não-gestão.
//
// PORTÃO: `podeVerTudo(email)` — mesma regra da rota em App.jsx e da RPC no banco.
//
// NÃO altera nenhuma regra operacional, fila, carteira ou pagamento.

const S = {
  pagina: { padding: 24, maxWidth: 900, margin: "0 auto" },
  titulo: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  subtitulo: { fontSize: 14, color: "#6b7280", marginBottom: 24 },
  tabela: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 14,
  },
  th: {
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "2px solid #e5e7eb",
    fontWeight: 600,
    color: "#374151",
    fontSize: 13,
  },
  thNum: {
    textAlign: "right",
    padding: "8px 12px",
    borderBottom: "2px solid #e5e7eb",
    fontWeight: 600,
    color: "#374151",
    fontSize: 13,
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid #f3f4f6",
    fontFamily: "monospace",
    color: "#111827",
  },
  tdNum: {
    padding: "8px 12px",
    borderBottom: "1px solid #f3f4f6",
    textAlign: "right",
    color: "#374151",
  },
  tdData: {
    padding: "8px 12px",
    borderBottom: "1px solid #f3f4f6",
    textAlign: "right",
    color: "#6b7280",
    fontSize: 13,
  },
  aviso: {
    marginTop: 32,
    padding: 16,
    borderRadius: 8,
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    fontSize: 14,
  },
  carregando: {
    marginTop: 32,
    color: "#6b7280",
    fontSize: 14,
  },
  vazio: {
    marginTop: 32,
    padding: 20,
    borderRadius: 8,
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    color: "#6b7280",
    fontSize: 14,
    textAlign: "center",
  },
  badge: (n) => ({
    display: "inline-block",
    minWidth: 32,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    color: n >= 50 ? "#1d4ed8" : n >= 10 ? "#374151" : "#9ca3af",
    fontWeight: n >= 50 ? 700 : 400,
  }),
};

export default function UsoCrm({ usuario }) {
  const email = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
  // { linhas: null | array, erro: null | string, carregando: bool }
  const [estado, setEstado] = useState({ linhas: null, erro: null, carregando: true });

  const ehGestao = podeVerTudo(email);

  useEffect(() => {
    if (!ehGestao) return;
    let ativo = true;
    supabase
      .rpc("uso_telas_por_rota")
      .then(({ data, error }) => {
        if (!ativo) return;
        if (error) {
          setEstado({ linhas: null, erro: error.message || "Erro ao carregar dados.", carregando: false });
          return;
        }
        setEstado({ linhas: data || [], erro: null, carregando: false });
      });
    return () => { ativo = false; };
  }, [ehGestao]);

  const { linhas, erro, carregando } = estado;

  if (!ehGestao) {
    return (
      <div style={S.pagina}>
        <div style={S.aviso}>Acesso restrito à gestão.</div>
      </div>
    );
  }

  return (
    <div style={S.pagina}>
      <div style={S.titulo}>Uso do CRM</div>
      <div style={S.subtitulo}>
        Acessos por rota nos últimos 30 dias — ordenado por total de acessos.
      </div>

      {erro && <div style={S.aviso}>{erro}</div>}

      {!erro && carregando && (
        <div style={S.carregando}>Carregando…</div>
      )}

      {!erro && !carregando && linhas !== null && linhas.length === 0 && (
        <div style={S.vazio}>
          Nenhum acesso registrado nos últimos 30 dias.
          <br />
          <span style={{ fontSize: 12, marginTop: 6, display: "block" }}>
            Os dados começam a aparecer após a migration ser aplicada e os
            usuários navegarem pelo CRM.
          </span>
        </div>
      )}

      {!erro && !carregando && linhas !== null && linhas.length > 0 && (
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>#</th>
              <th style={S.th}>Rota</th>
              <th style={S.thNum}>Acessos</th>
              <th style={S.thNum}>Usuários</th>
              <th style={S.thNum}>Último acesso</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((linha, i) => (
              <tr key={linha.rota}>
                <td style={{ ...S.tdNum, color: "#9ca3af", fontSize: 12 }}>
                  {i + 1}
                </td>
                <td style={S.td}>{linha.rota}</td>
                <td style={S.tdNum}>
                  <span style={S.badge(Number(linha.total_acessos))}>
                    {Number(linha.total_acessos).toLocaleString("pt-BR")}
                  </span>
                </td>
                <td style={S.tdNum}>{Number(linha.usuarios)}</td>
                <td style={S.tdData}>{linha.ultimo_acesso}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
