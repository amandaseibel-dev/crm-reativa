import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";

const FILTROS = [
  { valor: "MINHA_FILA", label: "Minha fila" },
  { valor: "TODOS", label: "Todos" },
  { valor: "SEM_RESPONSAVEL", label: "Sem responsável" },
  { valor: "RETORNOS_HOJE", label: "Retornos de hoje" },
  { valor: "NEGOCIACAO_24H", label: "Negociação 24h" },
];

function formatarDataHora(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "-";
  }
}

function pegarCampo(objeto, campos, padrao = "-") {
  for (const campo of campos) {
    if (
      objeto?.[campo] !== undefined &&
      objeto?.[campo] !== null &&
      objeto?.[campo] !== ""
    ) {
      return objeto[campo];
    }
  }

  return padrao;
}

function moeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";

  const numero = Number(valor);

  if (Number.isNaN(numero)) return valor;

  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function dataInicioHojeISO() {
  const agora = new Date();
  agora.setHours(0, 0, 0, 0);
  return agora.toISOString();
}

function dataFimHojeISO() {
  const agora = new Date();
  agora.setHours(23, 59, 59, 999);
  return agora.toISOString();
}

export default function FilaOperador() {
  const navigate = useNavigate();

  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("MINHA_FILA");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    iniciar();
  }, []);

  useEffect(() => {
    if (usuarioLogado) {
      carregarFila();
    }
  }, [filtro, usuarioLogado]);

  async function iniciar() {
    const usuario = await pegarUsuarioLogado();
    setUsuarioLogado(usuario);
  }

  async function pegarUsuarioLogado() {
    const { data, error } = await supabase.auth.getUser();

    if (error || !data?.user) {
      return {
        nome: "Usuário não identificado",
        email: null,
      };
    }

    const user = data.user;

    const nome =
      user.user_metadata?.nome ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "Usuário";

    return {
      nome,
      email: user.email,
    };
  }

  async function carregarFila() {
    setCarregando(true);
    setErro("");

    try {
      const termo = busca.trim();
      let query = supabase
        .from("alunos")
        .select("*")
        .limit(500);

      if (termo) {
        const somenteNumeros = termo.replace(/\D/g, "");

        if (somenteNumeros.length >= 3) {
          query = query.ilike("cpf", `%${somenteNumeros}%`);
        } else {
          query = query.ilike("nome", `%${termo}%`);
        }
      }

      if (filtro === "MINHA_FILA" && usuarioLogado?.email) {
        query = query.eq("responsavel_atual_email", usuarioLogado.email);
      }

      if (filtro === "SEM_RESPONSAVEL") {
        query = query.is("responsavel_atual_email", null);
      }

      if (filtro === "RETORNOS_HOJE") {
        query = query
          .gte("data_retorno", dataInicioHojeISO())
          .lte("data_retorno", dataFimHojeISO());
      }

      if (filtro === "NEGOCIACAO_24H") {
        query = query.eq("status_jornada", "ALUNO_EM_NEGOCIACAO_24H");
      }

      const { data, error } = await query;

      if (error) {
        console.error("Erro ao carregar fila:", error);
        setErro("Erro ao carregar a fila do operador.");
        setAlunos([]);
        return;
      }

      setAlunos(data || []);
    } catch (e) {
      console.error("Erro inesperado ao carregar fila:", e);
      setErro("Erro inesperado ao carregar a fila.");
      setAlunos([]);
    } finally {
      setCarregando(false);
    }
  }

  function abrirAlunoDaFila(aluno) {
    if (!aluno?.id) {
      alert("Aluno sem ID. Não foi possível abrir a ficha.");
      return;
    }

    localStorage.setItem("reativa_aluno_abrir_id", aluno.id);

    navigate(`/alunos?alunoId=${aluno.id}`);
  }

  const resumo = useMemo(() => {
    const total = alunos.length;

    const semResponsavel = alunos.filter(
      (aluno) => !aluno.responsavel_atual_email
    ).length;

    const retornosHoje = alunos.filter((aluno) => {
      if (!aluno.data_retorno) return false;

      const data = new Date(aluno.data_retorno);
      const inicio = new Date(dataInicioHojeISO());
      const fim = new Date(dataFimHojeISO());

      return data >= inicio && data <= fim;
    }).length;

    const negociacao24h = alunos.filter(
      (aluno) =>
        aluno.status_jornada === "ALUNO_EM_NEGOCIACAO_24H" ||
        aluno.status_atual === "ALUNO_EM_NEGOCIACAO_24H"
    ).length;

    return {
      total,
      semResponsavel,
      retornosHoje,
      negociacao24h,
    };
  }, [alunos]);

  return (
    <div style={pagina}>
      <div style={cabecalho}>
        <div>
          <h1 style={titulo}>Fila do operador</h1>
          <p style={subtitulo}>
            Clique no aluno para abrir a ficha diretamente, sem precisar pesquisar novamente.
          </p>

          <p style={usuarioTexto}>
            Usuário logado:{" "}
            <strong>{usuarioLogado?.nome || "Carregando..."}</strong>
            {usuarioLogado?.email ? ` - ${usuarioLogado.email}` : ""}
          </p>
        </div>

        <button
          onClick={carregarFila}
          disabled={carregando}
          style={botaoPrincipal}
        >
          {carregando ? "Carregando..." : "Atualizar fila"}
        </button>
      </div>

      <div style={cardsResumo}>
        <div style={cardResumo}>
          <strong>Total na visão</strong>
          <span>{resumo.total}</span>
        </div>

        <div style={cardResumo}>
          <strong>Sem responsável</strong>
          <span>{resumo.semResponsavel}</span>
        </div>

        <div style={cardResumo}>
          <strong>Retornos hoje</strong>
          <span>{resumo.retornosHoje}</span>
        </div>

        <div style={cardResumo}>
          <strong>Negociação 24h</strong>
          <span>{resumo.negociacao24h}</span>
        </div>
      </div>

      <div style={caixa}>
        <label style={label}>Buscar na fila por nome ou CPF</label>

        <div style={barraBusca}>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") carregarFila();
            }}
            placeholder="Digite nome ou CPF"
            style={input}
          />

          <select
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            style={selectFiltro}
          >
            {FILTROS.map((item) => (
              <option key={item.valor} value={item.valor}>
                {item.label}
              </option>
            ))}
          </select>

          <button
            onClick={carregarFila}
            disabled={carregando}
            style={botaoPrincipal}
          >
            Pesquisar
          </button>
        </div>

        {erro && <p style={erroTexto}>{erro}</p>}
      </div>

      <div style={caixa}>
        <h2 style={tituloSecao}>Alunos da fila</h2>

        {carregando ? (
          <p style={textoCinza}>Carregando fila...</p>
        ) : alunos.length === 0 ? (
          <div style={vazio}>
            <strong>Nenhum aluno encontrado.</strong>
            <p>
              Verifique o filtro selecionado ou pesquise pelo nome/CPF do aluno.
            </p>
          </div>
        ) : (
          <div style={lista}>
            {alunos.map((aluno) => {
              const nome = pegarCampo(
                aluno,
                ["nome", "nome_aluno", "aluno"],
                "Aluno sem nome"
              );

              const cpf = pegarCampo(aluno, ["cpf", "CPF"], "-");

              const status = pegarCampo(
                aluno,
                ["status_jornada", "status_atual", "status"],
                "CONTATAR"
              );

              const proximaAcao = pegarCampo(
                aluno,
                ["proxima_acao"],
                "CONTATAR"
              );

              const responsavel = aluno.responsavel_atual_nome || "Sem responsável";

              return (
                <button
                  key={aluno.id}
                  onClick={() => abrirAlunoDaFila(aluno)}
                  style={cardAluno}
                >
                  <div style={linhaTopoCard}>
                    <div>
                      <strong style={nomeAluno}>{nome}</strong>
                      <div style={textoCard}>CPF: {cpf}</div>
                    </div>

                    <span style={badgeStatus}>{status}</span>
                  </div>

                  <div style={gradeInfo}>
                    <div>
                      <strong>Responsável</strong>
                      <br />
                      {responsavel}
                    </div>

                    <div>
                      <strong>Próxima ação</strong>
                      <br />
                      {proximaAcao}
                    </div>

                    <div>
                      <strong>Último acionamento</strong>
                      <br />
                      {formatarDataHora(aluno.data_ultimo_acionamento)}
                    </div>

                    <div>
                      <strong>Retorno</strong>
                      <br />
                      {formatarDataHora(aluno.data_retorno)}
                    </div>

                    <div>
                      <strong>Valor em aberto</strong>
                      <br />
                      {moeda(aluno.valor_em_aberto)}
                    </div>

                    <div>
                      <strong>Status acionamento</strong>
                      <br />
                      {aluno.status_acionamento || "-"}
                    </div>
                  </div>

                  <div style={rodapeCard}>
                    Clique para abrir a ficha e finalizar atendimento
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const pagina = {
  minHeight: "100vh",
  background: "#020617",
  color: "#ffffff",
  padding: "24px",
  fontFamily: "Arial, sans-serif",
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "flex-start",
  marginBottom: "24px",
  flexWrap: "wrap",
};

const titulo = {
  margin: 0,
  color: "#22c55e",
};

const subtitulo = {
  margin: "6px 0 0",
  color: "#cbd5e1",
};

const usuarioTexto = {
  margin: "8px 0 0",
  color: "#94a3b8",
  fontSize: "14px",
};

const caixa = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "20px",
};

const tituloSecao = {
  color: "#22c55e",
  marginTop: 0,
};

const cardsResumo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "12px",
  marginBottom: "20px",
};

const cardResumo = {
  background: "#111827",
  border: "1px solid #22c55e",
  borderRadius: "14px",
  padding: "14px",
  display: "grid",
  gap: "8px",
};

const label = {
  display: "block",
  marginBottom: "8px",
  color: "#d1d5db",
};

const barraBusca = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
};

const input = {
  flex: "1 1 280px",
  background: "#020617",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
};

const selectFiltro = {
  width: "220px",
  background: "#020617",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
};

const botaoPrincipal = {
  background: "#22c55e",
  color: "#020617",
  border: "none",
  borderRadius: "10px",
  padding: "12px 16px",
  fontWeight: "bold",
  cursor: "pointer",
};

const lista = {
  display: "grid",
  gap: "12px",
};

const cardAluno = {
  width: "100%",
  textAlign: "left",
  background: "#1f2937",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "14px",
  padding: "14px",
  cursor: "pointer",
};

const linhaTopoCard = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start",
  marginBottom: "12px",
  flexWrap: "wrap",
};

const nomeAluno = {
  fontSize: "16px",
  color: "#ffffff",
};

const textoCard = {
  color: "#cbd5e1",
  fontSize: "13px",
  marginTop: "4px",
};

const badgeStatus = {
  background: "#064e3b",
  color: "#86efac",
  border: "1px solid #22c55e",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "bold",
};

const gradeInfo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "10px",
  color: "#d1d5db",
  fontSize: "13px",
};

const rodapeCard = {
  marginTop: "12px",
  paddingTop: "10px",
  borderTop: "1px solid #374151",
  color: "#86efac",
  fontSize: "13px",
  fontWeight: "bold",
};

const vazio = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "12px",
  padding: "16px",
  color: "#cbd5e1",
};

const textoCinza = {
  color: "#cbd5e1",
};

const erroTexto = {
  color: "#f87171",
  marginTop: "10px",
};