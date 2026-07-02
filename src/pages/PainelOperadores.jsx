import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeAcessoRestritoAmanda } from "../utils/operadores";

const PAUSAS = [
  { chave: "PAUSA_INTERVALO_1", label: "Pausa intervalo 1" },
  { chave: "PAUSA_INTERVALO_2", label: "Pausa intervalo 2" },
  { chave: "PAUSA_ALMOCO", label: "Pausa almoço" },
];

const FILTROS_PERIODO = [
  { valor: "HOJE", label: "Hoje" },
  { valor: "7_DIAS", label: "Últimos 7 dias" },
  { valor: "30_DIAS", label: "Últimos 30 dias" },
  { valor: "TODOS", label: "Todo o histórico" },
];

function formatarHora(data) {
  if (!data) return "-";
  return new Date(data).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatarData(dataISO) {
  const [ano, mes, dia] = dataISO.split("-");
  return `${dia}/${mes}/${ano}`;
}

function duracaoMinutos(inicio, fim) {
  if (!inicio || !fim) return null;
  return Math.round((new Date(fim).getTime() - new Date(inicio).getTime()) / 60000);
}

function dataDeCorte(periodo) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  if (periodo === "HOJE") return hoje.toISOString();

  if (periodo === "7_DIAS") {
    const corte = new Date(hoje);
    corte.setDate(corte.getDate() - 6);
    return corte.toISOString();
  }

  if (periodo === "30_DIAS") {
    const corte = new Date(hoje);
    corte.setDate(corte.getDate() - 29);
    return corte.toISOString();
  }

  return null;
}

function agruparPorDiaEOperador(eventos) {
  const grupos = new Map();

  for (const evento of eventos) {
    const dataISO = new Date(evento.criado_em).toISOString().slice(0, 10);
    const chave = `${evento.email}|${dataISO}`;

    if (!grupos.has(chave)) {
      grupos.set(chave, { email: evento.email, nome: evento.nome, data: dataISO, eventos: [] });
    }

    grupos.get(chave).eventos.push(evento);
  }

  const linhas = [];

  for (const grupo of grupos.values()) {
    const porTipo = (tipo, ultima = false) => {
      const lista = grupo.eventos.filter((e) => e.tipo === tipo);
      if (!lista.length) return null;
      return ultima ? lista[lista.length - 1].criado_em : lista[0].criado_em;
    };

    const pausas = PAUSAS.map(({ chave, label }) => {
      const inicio = porTipo(`${chave}_INICIO`);
      const fim = porTipo(`${chave}_FIM`);
      return { label, inicio, fim, duracao: duracaoMinutos(inicio, fim) };
    });

    linhas.push({
      email: grupo.email,
      nome: grupo.nome,
      data: grupo.data,
      login: porTipo("LOGIN"),
      logout: porTipo("LOGOUT", true),
      pausas,
    });
  }

  return linhas.sort((a, b) => {
    if (a.data !== b.data) return a.data < b.data ? 1 : -1;
    return a.nome.localeCompare(b.nome);
  });
}

export default function PainelOperadores() {
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [eventos, setEventos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [periodo, setPeriodo] = useState("7_DIAS");

  useEffect(() => {
    async function carregarUsuario() {
      const { data } = await supabase.auth.getSession();
      const email = data?.session?.user?.email;
      if (!email) return;

      const { data: perfil } = await supabase
        .from("usuarios")
        .select("*")
        .eq("email", email)
        .single();

      setUsuarioLogado(perfil);
    }

    carregarUsuario();
  }, []);

  useEffect(() => {
    if (!usuarioLogado) return;
    if (!podeAcessoRestritoAmanda(usuarioLogado.email)) return;

    carregarEventos();
  }, [usuarioLogado, periodo]);

  async function carregarEventos() {
    setCarregando(true);

    let query = supabase
      .from("ponto_operadores")
      .select("email, nome, tipo, criado_em")
      .order("criado_em", { ascending: true });

    const corte = dataDeCorte(periodo);
    if (corte) query = query.gte("criado_em", corte);

    const { data } = await query;
    setEventos(data || []);
    setCarregando(false);
  }

  const linhas = useMemo(() => agruparPorDiaEOperador(eventos), [eventos]);

  if (usuarioLogado && !podeAcessoRestritoAmanda(usuarioLogado.email)) {
    return (
      <div className="main">
        <h1>Painel de operadores</h1>
        <p>Você não tem acesso a esta página.</p>
      </div>
    );
  }

  return (
    <div className="main">
      <h1>Painel consolidado de operadores</h1>
      <p style={{ opacity: 0.75, marginBottom: 16 }}>
        Login, logout e pausas de cada operador. Histórico completo fica salvo — nada é
        sobrescrito.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTROS_PERIODO.map((filtro) => (
          <button
            key={filtro.valor}
            type="button"
            onClick={() => setPeriodo(filtro.valor)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border:
                periodo === filtro.valor
                  ? "1px solid rgba(59,130,246,0.7)"
                  : "1px solid rgba(148,163,184,0.35)",
              background: periodo === filtro.valor ? "rgba(59,130,246,0.15)" : "transparent",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {filtro.label}
          </button>
        ))}
      </div>

      {carregando ? (
        <p>Carregando...</p>
      ) : linhas.length === 0 ? (
        <p>Nenhum registro de ponto no período selecionado.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                <th style={{ padding: "8px 10px" }}>Data</th>
                <th style={{ padding: "8px 10px" }}>Operador</th>
                <th style={{ padding: "8px 10px" }}>Login</th>
                <th style={{ padding: "8px 10px" }}>Logout</th>
                {PAUSAS.map((p) => (
                  <th key={p.chave} style={{ padding: "8px 10px" }}>
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linhas.map((linha) => (
                <tr
                  key={`${linha.email}|${linha.data}`}
                  style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}
                >
                  <td style={{ padding: "8px 10px" }}>{formatarData(linha.data)}</td>
                  <td style={{ padding: "8px 10px" }}>{linha.nome}</td>
                  <td style={{ padding: "8px 10px" }}>{formatarHora(linha.login)}</td>
                  <td style={{ padding: "8px 10px" }}>{formatarHora(linha.logout)}</td>
                  {linha.pausas.map((pausa) => (
                    <td key={pausa.label} style={{ padding: "8px 10px" }}>
                      {pausa.inicio
                        ? `${formatarHora(pausa.inicio)}–${formatarHora(pausa.fim)}${
                            pausa.duracao != null ? ` (${pausa.duracao} min)` : " (em curso)"
                          }`
                        : "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
