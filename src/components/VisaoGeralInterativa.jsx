import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail, podeVerTudo } from "../utils/operadores";
import PlaylistReativa from "./portal/PlaylistReativa";
import MusicaDaSemana from "./portal/MusicaDaSemana";
import MuralElogios from "./portal/MuralElogios";
import DesafioSemana from "./portal/DesafioSemana";
import IdeiasEquipe from "./portal/IdeiasEquipe";
import useCurtidas from "./portal/useCurtidas";
import { ALVO_ELOGIO, ALVO_PLAYLIST, MODO_SEMANA, MODO_TOTAL } from "./portal/curtidas";

const CANOAS = { latitude: -29.9178, longitude: -51.1836 };

const CLIMA = {
  0: ["☀️", "Céu limpo"],
  1: ["🌤️", "Predominantemente limpo"],
  2: ["⛅", "Parcialmente nublado"],
  3: ["☁️", "Nublado"],
  45: ["🌫️", "Neblina"],
  48: ["🌫️", "Neblina"],
  51: ["🌦️", "Garoa fraca"],
  53: ["🌦️", "Garoa"],
  55: ["🌧️", "Garoa forte"],
  61: ["🌧️", "Chuva fraca"],
  63: ["🌧️", "Chuva"],
  65: ["🌧️", "Chuva forte"],
  71: ["🌨️", "Neve fraca"],
  73: ["🌨️", "Neve"],
  75: ["🌨️", "Neve forte"],
  80: ["🌦️", "Pancadas fracas"],
  81: ["🌧️", "Pancadas"],
  82: ["⛈️", "Pancadas fortes"],
  95: ["⛈️", "Trovoadas"],
  96: ["⛈️", "Trovoadas com granizo"],
  99: ["⛈️", "Trovoadas fortes"],
};

const CURIOSIDADES = [
  "Uma abordagem objetiva costuma funcionar melhor quando começa pela confirmação da pendência antes da proposta de negociação.",
  "Registrar objeções no CRM evita que o próximo contato repita a mesma abordagem e melhora a continuidade da negociação.",
  "Acordos devem ser tratados antes das mensalidades quando ambos estiverem disponíveis para o mesmo aluno.",
  "Quando há muitas opções de negociação, apresentar primeiro a alternativa mais aderente ao caso reduz confusão durante o atendimento.",
  "Um retorno combinado com data e horário tende a ser mais útil do que um registro genérico de 'retornar depois'.",
  "Antes de qualquer acionamento, conferir histórico, restrições e situação do aluno reduz retrabalho e contatos indevidos.",
  "Na cobrança educacional, clareza sobre valor, vencimento e próximo passo é mais importante do que mensagens longas.",
  "A qualidade do registro no CRM impacta diretamente a produtividade da equipe, porque evita reanálises do mesmo caso.",
];

function comoDataLocal(valor) {
  if (typeof valor === "string") {
    const dataIso = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dataIso) {
      const [, ano, mes, dia] = dataIso;
      return new Date(Number(ano), Number(mes) - 1, Number(dia));
    }
  }
  return new Date(valor);
}

function inicioDoDia(valor) {
  const d = comoDataLocal(valor);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatarDataCurta(valor) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(comoDataLocal(valor));
}

function formatarDataLonga(valor) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", timeZone: "America/Sao_Paulo"
  }).format(comoDataLocal(valor));
}

function diaSemana(valor) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "America/Sao_Paulo" })
    .format(comoDataLocal(valor))
    .replace(".", "")
    .replace(/^./, (c) => c.toUpperCase());
}

function hojeCanoasIso() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const mapa = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function proximaOcorrenciaAniversario(mes, dia) {
  const hoje = inicioDoDia(new Date());
  let data = new Date(hoje.getFullYear(), Number(mes) - 1, Number(dia));
  if (data < hoje) data = new Date(hoje.getFullYear() + 1, Number(mes) - 1, Number(dia));
  return data;
}

function diasAte(valor) {
  const hoje = inicioDoDia(new Date());
  const alvo = inicioDoDia(valor);
  return Math.max(0, Math.round((alvo - hoje) / 86400000));
}

function Card({ children, style }) {
  return <div style={{ ...S.card, ...style }}>{children}</div>;
}

function CabecalhoCard({ icone, titulo, acao }) {
  return (
    <div style={S.cardHeader}>
      <div style={S.cardTitleWrap}>
        <span style={S.cardIcon}>{icone}</span>
        <strong style={S.cardTitle}>{titulo}</strong>
      </div>
      {acao || null}
    </div>
  );
}

export default function VisaoGeralInterativa() {
  const [usuario, setUsuario] = useState({ email: "", nome: "" });
  const [clima, setClima] = useState(null);
  const [erroClima, setErroClima] = useState("");
  const [eventos, setEventos] = useState([]);
  const [aniversarios, setAniversarios] = useState([]);
  const [feriados, setFeriados] = useState([]);
  const [erroEventos, setErroEventos] = useState("");
  const [erroAniversarios, setErroAniversarios] = useState("");
  const [abrirEvento, setAbrirEvento] = useState(false);
  const [abrirAniversario, setAbrirAniversario] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [evento, setEvento] = useState({ titulo: "", data: "", categoria: "Operação" });
  const [aniversario, setAniversario] = useState({ nome: "", dia: "", mes: "" });

  const podeGerir = podeVerTudo(usuario.email);
  const curtidas = useCurtidas(ALVO_PLAYLIST, MODO_SEMANA);
  const curtidasElogio = useCurtidas(ALVO_ELOGIO, MODO_TOTAL);

  const carregarDadosInternos = useCallback(async () => {
    const hojeIso = new Date().toISOString();
    const [e, a] = await Promise.all([
      supabase.from("portal_eventos").select("id,titulo,inicio_em,categoria").eq("ativo", true).gte("inicio_em", hojeIso).order("inicio_em", { ascending: true }).limit(8),
      supabase.from("portal_aniversarios").select("id,nome,dia,mes").eq("ativo", true).order("mes", { ascending: true }).order("dia", { ascending: true }),
    ]);

    if (e.error) {
      console.error("portal_eventos:", e.error);
      setErroEventos("Eventos temporariamente indisponíveis.");
    } else {
      setErroEventos("");
      setEventos(e.data || []);
    }

    if (a.error) {
      console.error("portal_aniversarios:", a.error);
      setErroAniversarios("Aniversários temporariamente indisponíveis.");
    } else {
      setErroAniversarios("");
      setAniversarios(a.data || []);
    }
  }, []);

  useEffect(() => {
    let ativo = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!ativo) return;
      const email = data?.user?.email || "";
      setUsuario({
        email,
        nome: data?.user?.user_metadata?.nome || nomeOperadorPorEmail(email),
      });
    });

    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${CANOAS.latitude}&longitude=${CANOAS.longitude}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=America%2FSao_Paulo&forecast_days=7`
    )
      .then((r) => {
        if (!r.ok) throw new Error("clima");
        return r.json();
      })
      .then((data) => {
        if (ativo) setClima(data);
      })
      .catch(() => {
        if (ativo) setErroClima("Não foi possível atualizar o clima agora.");
      });

    const ano = new Date().getFullYear();
    fetch(`https://brasilapi.com.br/api/feriados/v1/${ano}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((lista) => {
        if (!ativo || !Array.isArray(lista)) return;
        const hoje = inicioDoDia(new Date());
        setFeriados(lista.filter((x) => inicioDoDia(x.date) >= hoje).slice(0, 4));
      })
      .catch(() => {});

    carregarDadosInternos();
    return () => { ativo = false; };
  }, [carregarDadosInternos]);

  const aniversariosOrdenados = useMemo(() => {
    return (aniversarios || [])
      .map((item) => ({ ...item, proximaData: proximaOcorrenciaAniversario(item.mes, item.dia) }))
      .sort((a, b) => a.proximaData - b.proximaData)
      .slice(0, 5);
  }, [aniversarios]);

  const curiosidade = useMemo(() => {
    const agora = new Date();
    const inicioAno = new Date(agora.getFullYear(), 0, 0);
    const dia = Math.floor((agora - inicioAno) / 86400000);
    return CURIOSIDADES[dia % CURIOSIDADES.length];
  }, []);

  async function adicionarEvento(e) {
    e.preventDefault();
    if (!evento.titulo.trim() || !evento.data) return;
    setSalvando(true);
    const { error } = await supabase.from("portal_eventos").insert({
      titulo: evento.titulo.trim(),
      inicio_em: new Date(evento.data).toISOString(),
      categoria: evento.categoria,
      criado_por_email: usuario.email,
    });
    setSalvando(false);
    if (error) { alert("Não foi possível adicionar o evento."); return; }
    setEvento({ titulo: "", data: "", categoria: "Operação" });
    setAbrirEvento(false);
    carregarDadosInternos();
  }

  async function adicionarAniversario(e) {
    e.preventDefault();
    const dia = Number(aniversario.dia);
    const mes = Number(aniversario.mes);
    if (!aniversario.nome.trim() || dia < 1 || dia > 31 || mes < 1 || mes > 12) {
      alert("Informe nome, dia e mês válidos.");
      return;
    }
    setSalvando(true);
    const { error } = await supabase.from("portal_aniversarios").insert({
      nome: aniversario.nome.trim(),
      dia,
      mes,
      criado_por_email: usuario.email,
    });
    setSalvando(false);
    if (error) { alert("Não foi possível adicionar o aniversário."); return; }
    setAniversario({ nome: "", dia: "", mes: "" });
    setAbrirAniversario(false);
    carregarDadosInternos();
  }

  const atual = clima?.current;
  const dias = clima?.daily?.time || [];

  return (
    <section style={S.wrap}>
      <div style={S.topline}>
        <div>
          <span style={S.eyebrow}>HOJE NA REATIVA</span>
          <h2 style={S.titulo}>Uma visão geral mais viva da equipe</h2>
        </div>
        <span style={S.dataHoje}>{formatarDataLonga(new Date())}</span>
      </div>

      <div style={S.mensagemDia}>
        <span style={S.mensagemDiaRotulo}>MENSAGEM DO DIA</span>
        <strong style={S.mensagemDiaTexto}>
          Dia de fechamento: foco em converter negociações em acordos fechados. Vamos concluir o que está em andamento e aproveitar cada oportunidade.
        </strong>
      </div>

      <MusicaDaSemana recarregarEm={curtidas.mapa} S={S} />

      <div style={S.gridFaixa2}>
        <MuralElogios usuario={usuario} curtidas={curtidasElogio} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />
        <DesafioSemana usuario={usuario} podeGerir={podeGerir} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />
      </div>

      <div style={S.gridFaixa3}>
        <PlaylistReativa usuario={usuario} curtidas={curtidas} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />
        <IdeiasEquipe usuario={usuario} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />
      </div>

      <div style={S.gridSecundario}>
        <Card style={S.climaCard}>
          <CabecalhoCard icone="🌤️" titulo="Clima em Canoas" />
          {clima ? (
            <>
              <div style={S.climaAtual}>
                <div>
                  <strong style={S.temperatura}>{Math.round(atual?.temperature_2m ?? 0)}°</strong>
                  <div style={S.climaDescricao}>{CLIMA[atual?.weather_code]?.[1] || "Condições atuais"}</div>
                </div>
                <span style={S.climaIconeGrande}>{CLIMA[atual?.weather_code]?.[0] || "🌤️"}</span>
              </div>
              <div style={S.previsao}>
                {dias.map((data, idx) => (
                  <div key={data} style={S.diaClima}>
                    <span style={S.diaSemana}>{data === hojeCanoasIso() ? "Hoje" : diaSemana(data)}</span>
                    <span style={S.iconeDia}>{CLIMA[clima.daily.weather_code?.[idx]]?.[0] || "🌤️"}</span>
                    <strong>{Math.round(clima.daily.temperature_2m_max?.[idx])}°</strong>
                    <span style={S.minima}>{Math.round(clima.daily.temperature_2m_min?.[idx])}°</span>
                    <span style={S.chuva}>💧 {clima.daily.precipitation_probability_max?.[idx] ?? 0}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : <p style={S.muted}>{erroClima || "Atualizando previsão..."}</p>}
        </Card>

        <Card>
          <CabecalhoCard
            icone="📅"
            titulo="Próximos eventos"
            acao={podeGerir ? <button type="button" onClick={() => setAbrirEvento((v) => !v)} style={S.botaoMini}>+ Evento</button> : null}
          />
          {abrirEvento && podeGerir && (
            <form onSubmit={adicionarEvento} style={S.form}>
              <input value={evento.titulo} onChange={(e) => setEvento({ ...evento, titulo: e.target.value })} placeholder="Nome do evento" style={S.input} />
              <input type="datetime-local" value={evento.data} onChange={(e) => setEvento({ ...evento, data: e.target.value })} style={S.input} />
              <select value={evento.categoria} onChange={(e) => setEvento({ ...evento, categoria: e.target.value })} style={S.input}>
                <option>Operação</option><option>Reunião</option><option>Treinamento</option><option>Campanha</option><option>Data importante</option>
              </select>
              <button disabled={salvando} style={S.botaoPrimario}>Salvar evento</button>
            </form>
          )}
          <div style={S.listaSimples}>
            {eventos.length ? eventos.slice(0, 5).map((item) => (
              <div key={item.id} style={S.linhaSimples}>
                <div style={S.dataQuadrado}>{formatarDataCurta(item.inicio_em)}</div>
                <div><strong>{item.titulo}</strong><div style={S.mutedPequeno}>{item.categoria || "Evento"}</div></div>
              </div>
            )) : <p style={S.muted}>{erroEventos || "Nenhum evento cadastrado para os próximos dias."}</p>}
          </div>
        </Card>

        <Card>
          <CabecalhoCard
            icone="🎂"
            titulo="Próximos aniversários"
            acao={podeGerir ? <button type="button" onClick={() => setAbrirAniversario((v) => !v)} style={S.botaoMini}>+ Aniversário</button> : null}
          />
          {abrirAniversario && podeGerir && (
            <form onSubmit={adicionarAniversario} style={S.form}>
              <input value={aniversario.nome} onChange={(e) => setAniversario({ ...aniversario, nome: e.target.value })} placeholder="Nome" style={S.input} />
              <div style={S.formLinha}>
                <input type="number" min="1" max="31" value={aniversario.dia} onChange={(e) => setAniversario({ ...aniversario, dia: e.target.value })} placeholder="Dia" style={S.input} />
                <input type="number" min="1" max="12" value={aniversario.mes} onChange={(e) => setAniversario({ ...aniversario, mes: e.target.value })} placeholder="Mês" style={S.input} />
              </div>
              <button disabled={salvando} style={S.botaoPrimario}>Salvar aniversário</button>
            </form>
          )}
          <div style={S.listaSimples}>
            {aniversariosOrdenados.length ? aniversariosOrdenados.map((item) => {
              const faltam = diasAte(item.proximaData);
              return (
                <div key={item.id} style={S.linhaSimples}>
                  <div style={S.dataQuadrado}>{String(item.dia).padStart(2, "0")}/{String(item.mes).padStart(2, "0")}</div>
                  <div><strong>{item.nome}</strong><div style={S.mutedPequeno}>{faltam === 0 ? "É hoje" : `Faltam ${faltam} dia${faltam === 1 ? "" : "s"}`}</div></div>
                </div>
              );
            }) : <p style={S.muted}>{erroAniversarios || "Cadastre os aniversários da equipe para acompanhar aqui."}</p>}
          </div>
        </Card>

        <Card>
          <CabecalhoCard icone="🇧🇷" titulo="Próximos feriados" />
          <div style={S.listaSimples}>
            {feriados.length ? feriados.map((item) => (
              <div key={item.date} style={S.linhaSimples}>
                <div style={S.dataQuadrado}>{formatarDataCurta(item.date)}</div>
                <div><strong>{item.name}</strong><div style={S.mutedPequeno}>Feriado nacional</div></div>
              </div>
            )) : <p style={S.muted}>Consultando o calendário nacional...</p>}
          </div>
        </Card>

        <Card style={S.curiosidadeCard}>
          <CabecalhoCard icone="💡" titulo="Curiosidade sobre cobrança" />
          <blockquote style={S.curiosidade}>{curiosidade}</blockquote>
          <div style={S.curiosidadeRodape}>Conteúdo rotativo para discussão rápida da equipe.</div>
        </Card>
      </div>
    </section>
  );
}

const S = {
  wrap: { margin: "22px 0 26px" },
  topline: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 14, flexWrap: "wrap" },
  eyebrow: { fontSize: 11, letterSpacing: ".1em", fontWeight: 900, color: "var(--rv-azul-texto)" },
  titulo: { margin: "5px 0 0", fontSize: 24, lineHeight: 1.15, color: "var(--rv-tinta)" },
  dataHoje: { color: "var(--rv-texto-suave)", fontSize: 13, textTransform: "capitalize" },
  mensagemDia: { display: "grid", gap: 5, marginBottom: 14, padding: "14px 16px", borderRadius: 16, background: "linear-gradient(135deg, var(--rv-azul-fundo), var(--rv-superficie))", border: "1px solid var(--rv-borda-suave)" },
  mensagemDiaRotulo: { fontSize: 10, letterSpacing: ".1em", fontWeight: 900, color: "var(--rv-azul-texto)" },
  mensagemDiaTexto: { fontSize: 14, lineHeight: 1.45, color: "var(--rv-tinta)" },
  gridPrincipal: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 },
  gridSecundario: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  card: { border: "1px solid var(--rv-borda)", borderRadius: 20, padding: 18, background: "var(--rv-superficie)", boxShadow: "0 8px 26px rgba(15,23,42,.05)", minWidth: 0 },
  climaCard: { overflow: "hidden", gridColumn: "1 / -1" },
  playlistCard: { minHeight: 300 },
  cardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  cardTitleWrap: { display: "flex", alignItems: "center", gap: 9 },
  cardIcon: { fontSize: 20 },
  cardTitle: { fontSize: 15, color: "var(--rv-tinta)" },
  climaAtual: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0 18px" },
  temperatura: { fontSize: 44, lineHeight: 1, letterSpacing: "-.04em" },
  climaDescricao: { marginTop: 5, color: "var(--rv-texto-suave)", fontSize: 13 },
  climaIconeGrande: { fontSize: 50 },
  previsao: { display: "grid", gridTemplateColumns: "repeat(7, minmax(64px, 1fr))", gap: 7, overflowX: "auto", paddingBottom: 3 },
  diaClima: { display: "grid", justifyItems: "center", gap: 5, padding: "10px 5px", background: "var(--rv-fundo-suave)", borderRadius: 13, border: "1px solid var(--rv-borda-suave)", minWidth: 64 },
  diaSemana: { fontSize: 11, fontWeight: 800, color: "var(--rv-texto-suave)" },
  iconeDia: { fontSize: 20 },
  minima: { fontSize: 12, color: "var(--rv-texto-suave)" },
  chuva: { fontSize: 10, color: "var(--rv-azul-texto)" },
  muted: { color: "var(--rv-texto-suave)", fontSize: 13, lineHeight: 1.5, margin: "8px 0" },
  mutedPequeno: { color: "var(--rv-texto-suave)", fontSize: 11, marginTop: 2 },
  botaoMini: { border: "1px solid var(--rv-borda)", borderRadius: 10, background: "var(--rv-fundo-suave)", color: "var(--rv-tinta)", fontWeight: 800, padding: "7px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 },
  botaoMiniDesligado: { opacity: .5, cursor: "not-allowed" },
  botaoCurtir: { border: "1px solid var(--rv-borda)", borderRadius: 999, background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontWeight: 800, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, whiteSpace: "nowrap" },
  botaoCurtirAtivo: { borderColor: "var(--rv-azul)", background: "var(--rv-azul-fundo)", color: "var(--rv-azul-texto)" },
  semanaFaixa: { margin: "0 0 14px", padding: "16px 18px", borderRadius: 20, border: "1px solid var(--rv-borda)", background: "linear-gradient(135deg, var(--rv-azul-fundo), var(--rv-superficie))", boxShadow: "0 8px 26px rgba(15,23,42,.05)" },
  semanaRotulo: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  semanaIcone: { fontSize: 18 },
  semanaEyebrow: { fontSize: 11, letterSpacing: ".1em", fontWeight: 900, color: "var(--rv-azul-texto)" },
  // Flex com wrap em vez de 3 colunas fixas: a 375px as colunas colidiam e o
  // "Escolhida por" passava por cima da contagem. Assim a contagem desce para a
  // linha de baixo no celular e fica a direita no desktop, sem media query.
  semanaAlvo: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", textDecoration: "none", color: "inherit" },
  semanaCapa: { width: 120, height: 80, objectFit: "cover", borderRadius: 12, background: "#ddd" },
  semanaTexto: { display: "grid", gap: 3, flex: "1 1 200px", minWidth: 0 },
  // Titulo de destaque quebra em vez de virar reticencias: e o elemento principal
  // da faixa, e "Vou pra Santa Ca..." nao serve como destaque.
  semanaTitulo: { fontSize: 19, lineHeight: 1.2, color: "var(--rv-tinta)" },
  semanaArtista: { fontSize: 14, color: "var(--rv-texto-suave)" },
  semanaQuem: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  semanaContagem: { display: "grid", justifyItems: "end", gap: 2, textAlign: "right", marginLeft: "auto" },
  semanaNumero: { fontSize: 22, lineHeight: 1, color: "var(--rv-tinta)", whiteSpace: "nowrap" },
  semanaNumeroRotulo: { fontSize: 11, color: "var(--rv-texto-suave)" },
  semanaVazio: { margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--rv-texto-suave)" },
  semanaVazioDica: { color: "var(--rv-texto-fraco)" },
  gridFaixa3: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14, marginBottom: 14 },
  seletorOrdem: { border: "1px solid var(--rv-borda)", borderRadius: 10, background: "var(--rv-fundo-suave)", color: "var(--rv-tinta)", fontWeight: 800, padding: "6px 8px", fontFamily: "inherit", fontSize: 12 },
  listaIdeias: { display: "grid", gap: 10 },
  ideia: { padding: "10px 12px", borderRadius: 12, background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)" },
  ideiaTexto: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--rv-tinta)" },
  ideiaRodape: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" },
  ideiaEspaco: { marginLeft: "auto" },
  ideiaAutor: { fontSize: 12, fontWeight: 800, color: "var(--rv-tinta)" },
  ideiaData: { fontSize: 11, color: "var(--rv-texto-suave)" },
  ideiasAcoes: { display: "flex", alignItems: "center", gap: 8 },
  ideiaMinha: { fontSize: 10, fontWeight: 900, letterSpacing: ".04em", color: "var(--rv-verde-ok)", border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "3px 8px" },
  ideiaStatus: { fontSize: 10, fontWeight: 900, letterSpacing: ".04em", color: "var(--rv-azul-texto)", background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "3px 8px" },
  gridFaixa2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14, marginBottom: 14 },
  listaElogios: { display: "grid", gap: 10 },
  elogio: { padding: "10px 12px", borderRadius: 12, background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)" },
  elogioTexto: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--rv-tinta)", borderLeft: "3px solid var(--rv-azul)", paddingLeft: 10 },
  elogioRodape: { display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" },
  elogioQuem: { fontSize: 12, fontWeight: 800, color: "var(--rv-tinta)" },
  elogioData: { fontSize: 11, color: "var(--rv-texto-suave)", marginRight: "auto" },
  desafio: { display: "grid", gap: 6 },
  desafioTitulo: { fontSize: 15, color: "var(--rv-tinta)", lineHeight: 1.25 },
  desafioTexto: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--rv-texto-suave)" },
  desafioObjetivo: { margin: 0, fontSize: 13, lineHeight: 1.45, color: "var(--rv-tinta)" },
  desafioMedida: { display: "grid", gap: 6, marginTop: 4 },
  desafioNumeros: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  desafioProgresso: { fontSize: 22, lineHeight: 1, color: "var(--rv-tinta)", letterSpacing: "-.02em" },
  barra: { height: 9, borderRadius: 999, background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)", overflow: "hidden" },
  barraCheia: { height: "100%", background: "var(--rv-azul)", borderRadius: 999, transition: "width .3s ease" },
  barraCumprida: { background: "var(--rv-verde-ok)" },
  desafioCumprido: { fontSize: 12, fontWeight: 800, color: "var(--rv-verde-ok)" },
  desafioPeriodo: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 2 },
  form: { display: "grid", gap: 8, padding: 10, background: "var(--rv-fundo-suave)", borderRadius: 12, marginBottom: 12 },
  formLinha: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid var(--rv-borda)", borderRadius: 9, padding: "9px 10px", background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontFamily: "inherit" },
  botaoPrimario: { border: 0, borderRadius: 9, background: "var(--rv-azul)", color: "#fff", fontWeight: 800, padding: "9px 12px", cursor: "pointer", fontFamily: "inherit" },
  playlistContador: { display: "grid", gap: 2, marginBottom: 10 },
  playlistContadorForte: { fontSize: 13, color: "var(--rv-tinta)" },
  playlistVerTodas: { marginTop: 10, border: "1px solid var(--rv-borda)", borderRadius: 10, background: "transparent", color: "var(--rv-azul-texto)", fontWeight: 800, padding: "7px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, width: "100%" },
  listaMusicas: { display: "grid", gap: 8 },
  musicaLinha: { display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "center", border: "1px solid var(--rv-borda-suave)", borderRadius: 12, padding: 7, background: "var(--rv-fundo-suave)" },
  musicaAlvo: { display: "grid", gridTemplateColumns: "72px minmax(0,1fr)", gap: 10, alignItems: "center", textDecoration: "none", color: "inherit", minWidth: 0 },
  musicaAcoes: { display: "grid", gap: 4 },
  botaoAcaoMusica: { border: "1px solid var(--rv-borda)", borderRadius: 8, background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontWeight: 800, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", fontSize: 11 },
  thumb: { width: 72, height: 48, objectFit: "cover", borderRadius: 8, background: "#ddd" },
  musicaTexto: { minWidth: 0, display: "grid", gap: 1 },
  badge: { fontSize: 9, letterSpacing: ".08em", fontWeight: 900, color: "var(--rv-azul-texto)" },
  musicaTitulo: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  musicaArtista: { fontSize: 12, color: "var(--rv-texto-suave)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  adicionadoPor: { fontSize: 10, color: "var(--rv-texto-fraco)", marginTop: 2 },
  play: { fontSize: 18, color: "var(--rv-azul-texto)", paddingRight: 6 },
  listaSimples: { display: "grid", gap: 9 },
  linhaSimples: { display: "grid", gridTemplateColumns: "52px minmax(0,1fr)", gap: 10, alignItems: "center" },
  dataQuadrado: { width: 52, height: 42, borderRadius: 10, background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 900, color: "var(--rv-azul-texto)" },
  curiosidadeCard: { background: "linear-gradient(135deg, var(--rv-superficie), var(--rv-azul-fundo))" },
  curiosidade: { margin: "14px 0", fontSize: 15, lineHeight: 1.55, color: "var(--rv-tinta)", borderLeft: "3px solid var(--rv-azul)", paddingLeft: 12 },
  curiosidadeRodape: { fontSize: 11, color: "var(--rv-texto-suave)" },
};
