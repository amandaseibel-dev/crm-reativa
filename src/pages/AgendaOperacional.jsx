import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";
import BotaoManual from "../components/BotaoManual";import Alunos from "./Aluno";

const STATUS_FINALIZACAO = [
  "CONTATAR",
  "ELOGIO_ATENDIMENTO",
  "MENSAGEM_ENVIADA",
  "EM_ATENDIMENTO",
  "ALUNO_EM_NEGOCIACAO_24H",
  "RETORNAR_DEPOIS",
  "SEM_RETORNO",
  "NAO_LOCALIZADO",
  "AGUARDANDO_LINK",
  "SOLICITADO_LINK",
  "LINK_PRONTO_PARA_ENVIO",
  "AGUARDANDO_COMPROVANTE",
  "AGUARDANDO_BAIXA",
  "BAIXA_REALIZADA",
  "BAIXA_DEVOLVIDA",
  "TERMO_ENVIADO_ALUNO",
  "TERMO_ENVIADO_ADM",
  "TERMO_RECEBIDO_LIBERADO",
  "TERMO_REJEITADO",
  "ACORDO_FECHADO",
  "CANCELAMENTO_COBRANCA",
  "SUSPENSAO_COBRANCA",
  "JURIDICO",
];

const OPERADORES = [
  "OLGA",
  "ALLAN",
  "DIEGO",
  "RAFAELLA",
  "MAURICIO",
  "LUANA",
  "NATALY",
  "JOÃO",
  "AMANDA",
];

const STATUS_LABEL = {
  EM_COBRANCA: "Em cobrança",
  RETORNO_AGENDADO: "Retorno agendado",
  EM_NEGOCIACAO: "Em negociação",
  AGUARDANDO_LINK: "Aguardando link",
  AGUARDANDO_TERMO: "Aguardando termo",
  PAGAMENTO_IDENTIFICADO: "Pagamento identificado",
  REVISAR_UNIFICACAO: "Revisar unificação",
  NAO_CONTATAR: "Não contatar",
  QUITADO: "Quitado",
};

function hojeISO() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function isoData(ano, mesZero, dia) {
  return `${ano}-${String(mesZero + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function dataBR(valor) {
  if (!valor) return "-";

  try {
    const partes = String(valor).split("T")[0].split("-");
    if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
    return new Date(valor).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function nomeMes(data) {
  return data.toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
}

function corStatus(status) {
  if (status === "RETORNO_AGENDADO") return "#0ea5e9";
  if (status === "EM_NEGOCIACAO") return "#8b5cf6";
  if (status === "AGUARDANDO_LINK") return "#f59e0b";
  if (status === "AGUARDANDO_TERMO") return "#ec4899";
  if (status === "PAGAMENTO_IDENTIFICADO") return "#3b82f6";
  if (status === "REVISAR_UNIFICACAO") return "#ef4444";
  return "#64748b";
}


// Quem enxerga a agenda geral (de todo mundo). A Amanda ADM
// (cobranca07) faz acionamento como os demais operadores, então a agenda
// dela mostra só os casos que ela mesma atendeu -- não entra nessa lista.
function podeVerAgendaGeral(email) {
  const e = String(email || "").toLowerCase();

  return [
    "amanda.seibel@aelbra.com.br",
    "cobranca04@aelbra.com.br",
  ].includes(e);
}

export default function AgendaOperacional() {
  const [usuario, setUsuario] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [mesAtual, setMesAtual] = useState(new Date());
  const [diaSelecionado, setDiaSelecionado] = useState(hojeISO());
  const [busca, setBusca] = useState(""); const [fichaId, setFichaId] = useState(null);
  const [filtroOperador, setFiltroOperador] = useState("TODOS");
  const [filtroTipoFinalizacao, setFiltroTipoFinalizacao] = useState("TODOS");

  useEffect(() => {
    carregarUsuario();
    carregarAgenda();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarAgenda() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("alunos_unificados")
      .select("*")
      .eq("ocultar_fila", false)
      .not("status_jornada", "eq", "QUITADO")
      .not("status_jornada", "eq", "NAO_CONTATAR")
      .order("data_retorno", { ascending: true })
      .limit(5000);

    if (error) {
      alert("Erro ao carregar Agenda Operacional: " + error.message);
      setCarregando(false);
      return;
    }

    setAlunos(data || []);
    setCarregando(false);
  }

  function abrirCadastroAluno(item) {
    const alunoSelecionado = {
      id: item.id,
      chave_unificacao: item.chave_unificacao || "",
      nome: item.nome_aluno || item.nome_referencia || "Aluno sem nome",
      nome_aluno: item.nome_aluno || item.nome_referencia || "Aluno sem nome",
      cpf: item.cpf_referencia || "",
      cpf_mascarado: item.cpf_referencia || "",
      matricula: item.matricula || "-",
      valor_em_aberto: item.valor_total_casos || 0,
      valor_total: item.valor_total_casos || 0,
      operador: item.operador_nome || "",
      operador_nome: item.operador_nome || "",
      operador_email: item.operador_email || "",
      data_retorno: item.data_retorno || null,
      hora_retorno: item.hora_retorno || null,
      status_atual: item.status_jornada || "EM_COBRANCA",
      status_jornada: item.status_jornada || "EM_COBRANCA",
      prioridade_operacional: item.prioridade_operacional || "NORMAL",
      observacao_operacional: item.observacao_operacional || "",
      quantidade_casos: item.quantidade_casos || 0,
      quantidade_cpfs: item.quantidade_cpfs || 0,
      valor_total_casos: item.valor_total_casos || 0,
    };

    localStorage.setItem("alunoSelecionado", JSON.stringify(alunoSelecionado));
    window.location.href = "/aluno";
  }

  async function abrirFichaDireto(item) { const cpf = String(item.cpf_referencia || "").trim(); if (cpf) { const { data } = await supabase.from("alunos").select("id").eq("cpf", cpf).limit(1); if (data && data[0] && data[0].id) { setFichaId(data[0].id); return; } } abrirCadastroAluno(item); } function mudarMes(delta) {
    const novo = new Date(mesAtual);
    novo.setMonth(novo.getMonth() + delta);
    setMesAtual(novo);
    setDiaSelecionado("");
  }

  const emailUsuario = usuario?.email || "";
  const nomeUsuario = nomeOperadorPorEmail(emailUsuario);
  const adm = podeVerAgendaGeral(emailUsuario);

  const alunosFiltrados = useMemo(() => {
    let lista = [...alunos];

    lista = lista.filter((item) => item.data_retorno);

    if (!adm) {
      lista = lista.filter((item) => {
        const emailItem = String(item.operador_email || "").toLowerCase();
        const nomeItem = String(item.operador_nome || "").toUpperCase();

        return (
          emailItem === emailUsuario.toLowerCase() ||
          nomeItem === String(nomeUsuario || "").toUpperCase()
        );
      });
    }

    if (adm && filtroOperador !== "TODOS") {
      if (filtroOperador === "SEM_OPERADOR") {
        lista = lista.filter((item) => !item.operador_nome && !item.operador_email);
      } else {
        lista = lista.filter(
          (item) => String(item.operador_nome || "").toUpperCase() === filtroOperador
        );
      }
    }

    if (filtroTipoFinalizacao !== "TODOS") {
      lista = lista.filter((item) => item.status_jornada === filtroTipoFinalizacao);
    }

    if (busca.trim()) {
      const termo = busca.toLowerCase().trim();

      lista = lista.filter((item) =>
        [
          item.nome_aluno,
          item.nome_referencia,
          item.cpf_referencia,
          item.operador_nome,
          item.operador_email,
          item.status_jornada,
          item.observacao_operacional,
        ]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return lista;
  }, [alunos, filtroOperador, filtroTipoFinalizacao, busca, adm, emailUsuario, nomeUsuario]);

  const mapaPorDia = useMemo(() => {
    const mapa = {};

    alunosFiltrados.forEach((item) => {
      const dia = String(item.data_retorno || "").split("T")[0];
      if (!dia) return;

      if (!mapa[dia]) mapa[dia] = [];
      mapa[dia].push(item);
    });

    Object.keys(mapa).forEach((dia) => {
      mapa[dia].sort((a, b) =>
        String(a.hora_retorno || "99:99").localeCompare(String(b.hora_retorno || "99:99"))
      );
    });

    return mapa;
  }, [alunosFiltrados]);

  const diasCalendario = useMemo(() => {
    const ano = mesAtual.getFullYear();
    const mes = mesAtual.getMonth();
    const primeiroDia = new Date(ano, mes, 1);
    const ultimoDia = new Date(ano, mes + 1, 0);
    const inicioSemana = primeiroDia.getDay();
    const totalDias = ultimoDia.getDate();

    const dias = [];

    for (let i = 0; i < inicioSemana; i++) {
      dias.push(null);
    }

    for (let dia = 1; dia <= totalDias; dia++) {
      dias.push(isoData(ano, mes, dia));
    }

    while (dias.length % 7 !== 0) {
      dias.push(null);
    }

    return dias;
  }, [mesAtual]);

  const listaDiaSelecionado = diaSelecionado ? mapaPorDia[diaSelecionado] || [] : [];

  const indicadores = useMemo(() => {
    const hoje = hojeISO();

    return {
      totalAgendado: alunosFiltrados.length,
      hoje: alunosFiltrados.filter((x) => String(x.data_retorno).split("T")[0] === hoje).length,
      atrasados: alunosFiltrados.filter((x) => String(x.data_retorno).split("T")[0] < hoje).length,
      futuros: alunosFiltrados.filter((x) => String(x.data_retorno).split("T")[0] > hoje).length,
    };
  }, [alunosFiltrados]);

  if (carregando) {
    return (
      <div style={styles.container}>
        <BotaoManual />
        Carregando Agenda Operacional...
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <BotaoManual />

      {fichaId && (<div style={styles.modalOverlay} onClick={() => setFichaId(null)}><div style={styles.modalBox} onClick={(e) => e.stopPropagation()}><div style={styles.modalTopo}><h3 style={{ margin: 0, color: "#0d1321" }}>Ficha do aluno</h3><button style={styles.modalFechar} onClick={() => setFichaId(null)}>Fechar</button></div><Alunos fichaEmbedId={fichaId} /></div></div>)} <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Agenda Operacional</h1>
          <p style={styles.subtitulo}>
            Calendário geral dos retornos e agendamentos registrados pela operação.
          </p>
        </div>

        <div style={styles.botoesTopo}>
          <button style={styles.botaoEscuro} onClick={() => (window.location.href = "/minha-fila")}>
            Fila Operacional
          </button>

          <button style={styles.botaoEscuro} onClick={carregarAgenda}>
            Atualizar
          </button>
        </div>
      </div>

      <div style={styles.indicadores}>
        <div style={styles.indicador}>
          <strong>{indicadores.totalAgendado}</strong>
          <span>Total agendado</span>
        </div>

        <div style={styles.indicador}>
          <strong>{indicadores.hoje}</strong>
          <span>Hoje</span>
        </div>

        <div style={styles.indicador}>
          <strong>{indicadores.atrasados}</strong>
          <span>Atrasados</span>
        </div>

        <div style={styles.indicador}>
          <strong>{indicadores.futuros}</strong>
          <span>Futuros</span>
        </div>
      </div>

      <div style={styles.filtros}>
        <input
          style={styles.input}
          placeholder="Buscar por aluno, CPF, operador ou observação..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />

        <select
          style={styles.input}
          value={filtroTipoFinalizacao}
          onChange={(e) => setFiltroTipoFinalizacao(e.target.value)}
        >
          <option value="TODOS">Todos os tipos de finalização</option>
          {STATUS_FINALIZACAO.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
            </option>
          ))}
        </select>

        {adm ? (
          <select
            style={styles.input}
            value={filtroOperador}
            onChange={(e) => setFiltroOperador(e.target.value)}
          >
            <option value="TODOS">Todos os operadores</option>
            {OPERADORES.map((op) => (
              <option key={op} value={op}>
                Agenda de {op}
              </option>
            ))}
            <option value="SEM_OPERADOR">Sem operador</option>
          </select>
        ) : (
          <div style={styles.avisoAgendaOperador}>
            Sua agenda: {nomeUsuario || "Operador"}
          </div>
        )}
      </div>

      <div style={styles.layout}>
        <div style={styles.calendarioCard}>
          <div style={styles.controleMes}>
            <button style={styles.botaoMes} onClick={() => mudarMes(-1)}>
              ← Mês anterior
            </button>

            <h2 style={styles.mesTitulo}>{nomeMes(mesAtual)}</h2>

            <button style={styles.botaoMes} onClick={() => mudarMes(1)}>
              Próximo mês →
            </button>
          </div>

          <div style={styles.semana}>
            <div>Dom</div>
            <div>Seg</div>
            <div>Ter</div>
            <div>Qua</div>
            <div>Qui</div>
            <div>Sex</div>
            <div>Sáb</div>
          </div>

          <div style={styles.gradeCalendario}>
            {diasCalendario.map((dia, index) => {
              const agendados = dia ? mapaPorDia[dia] || [] : [];
              const selecionado = dia && dia === diaSelecionado;
              const hoje = dia && dia === hojeISO();

              return (
                <button
                  key={`${dia || "vazio"}-${index}`}
                  style={{
                    ...styles.dia,
                    ...(selecionado ? styles.diaSelecionado : {}),
                    ...(hoje ? styles.diaHoje : {}),
                    opacity: dia ? 1 : 0.25,
                  }}
                  disabled={!dia}
                  onClick={() => setDiaSelecionado(dia)}
                >
                  {dia && (
                    <>
                      <span style={styles.numeroDia}>{Number(dia.split("-")[2])}</span>

                      {agendados.length > 0 && (
                        <span style={styles.badgeAgenda}>
                          {agendados.length} retorno{agendados.length > 1 ? "s" : ""}
                        </span>
                      )}

                      <div style={styles.pontos}>
                        {agendados.slice(0, 4).map((item) => (
                          <span
                            key={`${item.chave_unificacao}-${item.hora_retorno}`}
                            style={{
                              ...styles.ponto,
                              background: corStatus(item.status_jornada),
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.listaCard}>
          <h2 style={styles.listaTitulo}>
            {diaSelecionado ? `Agendamentos de ${dataBR(diaSelecionado)}` : "Selecione um dia"}
          </h2>

          {listaDiaSelecionado.length === 0 && (
            <div style={styles.vazio}>
              Nenhum retorno agendado para este dia.
            </div>
          )}

          {listaDiaSelecionado.map((item) => (
            <div key={`${item.chave_unificacao}-${item.hora_retorno}`} style={styles.cardAluno}>
              <div style={styles.hora}>
                {item.hora_retorno ? String(item.hora_retorno).slice(0, 5) : "Sem hora"}
              </div>

              <h3 style={styles.nomeAluno}>
                {item.nome_aluno || item.nome_referencia || "Aluno sem nome"}
              </h3>

              <p style={styles.info}><strong>CPF:</strong> {item.cpf_referencia || "-"}</p>
              <p style={styles.info}><strong>Operador:</strong> {item.operador_nome || "Sem operador"}</p>
              <p style={styles.info}><strong>Status:</strong> {STATUS_LABEL[item.status_jornada] || item.status_jornada || "Em cobrança"}</p>
              <p style={styles.info}><strong>Valor:</strong> {dinheiro(item.valor_total_casos)}</p>

              {item.observacao_operacional && (
                <div style={styles.obs}>
                  {item.observacao_operacional}
                </div>
              )}

              <button style={styles.botaoVerde} onClick={() => abrirFichaDireto(item)}>
                Abrir cadastro do aluno
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles = { modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }, modalBox: { background: "#fff", borderRadius: 16, padding: 22, maxWidth: 1100, width: "100%", maxHeight: "88vh", overflowY: "auto" }, modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }, modalFechar: { background: "#f1f5f9", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13, fontWeight: 700 },
  container: {
    minHeight: "100%",
    background: "#f4f6fa",
    padding: "24px",
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#334155",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "18px",
  },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontSize: "26px",
    fontFamily: "'Sora', Inter, sans-serif",
    fontWeight: 800,
  },
  subtitulo: {
    margin: "6px 0 0 0",
    color: "#64748b",
  },
  botoesTopo: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  indicadores: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  indicador: {
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: "16px",
    padding: "16px",
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
  },
  filtros: {
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: "16px",
    padding: "16px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "10px",
    marginBottom: "16px",
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
  },
  input: {
    padding: "12px",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    color: "#0d1321",
    fontSize: "14px",
  },
  avisoAgendaOperador: {
    padding: "12px",
    borderRadius: "10px",
    border: "1px solid #bdeed4",
    background: "#eff6ff",
    color: "#1e40af",
    fontSize: "14px",
    fontWeight: "bold",
  },
  layout: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(320px, 0.8fr)",
    gap: "16px",
    alignItems: "start",
  },
  calendarioCard: {
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: "18px",
    padding: "18px",
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
  },
  controleMes: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "16px",
  },
  mesTitulo: {
    margin: 0,
    textTransform: "capitalize",
    color: "#0d1321",
    fontFamily: "'Sora', Inter, sans-serif",
  },
  botaoMes: {
    background: "#fff",
    color: "#334155",
    border: "1px solid #e2e8f0",
    padding: "10px 12px",
    borderRadius: "10px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  semana: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: "8px",
    marginBottom: "8px",
    color: "#8a93a3",
    fontWeight: "bold",
    textAlign: "center",
    fontSize: "13px",
  },
  gradeCalendario: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(90px, 1fr))",
    gap: "8px",
  },
  dia: {
    minHeight: "105px",
    background: "#f8fafc",
    color: "#334155",
    border: "1px solid #e6eaf0",
    borderRadius: "14px",
    padding: "10px",
    textAlign: "left",
    cursor: "pointer",
  },
  diaSelecionado: {
    border: "2px solid #2563eb",
    boxShadow: "0 0 0 2px rgba(15,157,107,0.15)",
  },
  diaHoje: {
    background: "#eff6ff",
  },
  numeroDia: {
    display: "block",
    fontSize: "18px",
    fontWeight: "bold",
    marginBottom: "8px",
  },
  badgeAgenda: {
    display: "inline-block",
    background: "#2563eb",
    color: "#fff",
    borderRadius: "999px",
    padding: "4px 8px",
    fontSize: "12px",
    fontWeight: "bold",
  },
  pontos: {
    display: "flex",
    gap: "4px",
    marginTop: "8px",
    flexWrap: "wrap",
  },
  ponto: {
    width: "8px",
    height: "8px",
    borderRadius: "999px",
  },
  listaCard: {
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: "18px",
    padding: "18px",
    maxHeight: "calc(100vh - 180px)",
    overflowY: "auto",
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
  },
  listaTitulo: {
    margin: "0 0 12px 0",
    color: "#0d1321",
    fontFamily: "'Sora', Inter, sans-serif",
  },
  cardAluno: {
    background: "#f8fafc",
    border: "1px solid #e6eaf0",
    borderRadius: "14px",
    padding: "14px",
    marginBottom: "12px",
  },
  hora: {
    display: "inline-block",
    background: "#2563eb",
    color: "#fff",
    borderRadius: "999px",
    padding: "5px 9px",
    fontWeight: "bold",
    fontSize: "12px",
    marginBottom: "8px",
  },
  nomeAluno: {
    margin: "0 0 8px 0",
    color: "#0d1321",
  },
  info: {
    margin: "5px 0",
    color: "#64748b",
    fontSize: "14px",
  },
  obs: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: "10px",
    padding: "10px",
    color: "#334155",
    marginTop: "10px",
    marginBottom: "10px",
    fontSize: "14px",
  },
  vazio: {
    background: "#f8fafc",
    border: "1px solid #e6eaf0",
    borderRadius: "12px",
    padding: "14px",
    color: "#8a93a3",
  },
  botaoEscuro: {
    background: "#fff",
    color: "#334155",
    border: "1px solid #e2e8f0",
    padding: "10px 13px",
    borderRadius: "10px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoVerde: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    padding: "10px 13px",
    borderRadius: "10px",
    cursor: "pointer",
    fontWeight: "bold",
    marginTop: "10px",
  },
};

