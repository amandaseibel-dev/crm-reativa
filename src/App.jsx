import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import {
  LayoutDashboard, Zap, Folder, Calendar, User, Phone, Heart,
  DollarSign, CreditCard, CheckCircle2, FileStack, Lock,
  BarChart3, Clock, Contact, LayoutPanelTop, Clock3, Database, Link2, TrendingUp,
  Upload, Users, Settings, UserCircle,
} from "lucide-react";
const ICONES_MENU = {
  LayoutDashboard, Zap, Folder, Calendar, User, Phone, Heart,
  DollarSign, CreditCard, CheckCircle2, FileStack, Lock,
  BarChart3, Clock, Contact, LayoutPanelTop, Clock3, Database, Link2, TrendingUp,
  Upload, Users, Settings, UserCircle,
};
import { supabase } from "./services/supabase";
import AutoLogout from "./components/AutoLogout";
import Dashboard from "./pages/Dashboard";
import BaseAnalitica from "./pages/BaseAnalitica";
import Importacoes from "./pages/Importacoes";
import Aluno from "./pages/Aluno";
import PainelCarteira from "./components/PainelCarteira";
import CRM from "./pages/CRM";
import Login from "./pages/Login";
import RedefinirSenha from "./pages/RedefinirSenha";
import Usuarios from "./pages/Usuarios";
import MinhaFila from "./pages/MinhaFila";
import FilaTermos from "./pages/FilaTermos";
import FilaAdmTermos from "./pages/FilaAdmTermos";
import BaseReceptiva from "./pages/BaseReceptiva";
import FilaOperacional from "./pages/FilaOperacional";
import ControleLinksPagamento from "./pages/ControleLinksPagamento";
import MinhaFilaPagamentos from "./pages/MinhaFilaPagamentos";
import AgendaOperacional from "./pages/AgendaOperacional";
import MinhaFilaQuitacao from "./pages/MinhaFilaQuitacao";
import ManualOperacao from "./pages/ManualOperacao";
import BotaoManual from "./components/BotaoManual";
import FilaFinanceiro from "./pages/FilaFinanceiro";
import FilaConfirmacaoPagamento from "./pages/FilaConfirmacaoPagamento";
import PainelOperadores from "./pages/PainelOperadores";
import MeuPerfil from "./pages/MeuPerfil";
import Borderos from "./pages/Borderos";
import ConsultaFinanceira from "./pages/ConsultaFinanceira";
import VincularBaseOperacional from "./pages/VincularBaseOperacional";
import { registrarLoginSeNecessario, registrarLogout } from "./utils/ponto";
import PainelAdm from "./pages/PainelAdm";
import FinanceiroHub from "./pages/FinanceiroHub";
import CentralPagamentos from "./components/CentralPagamentos";
import RelatorioTabulacoes from "./pages/RelatorioTabulacoes";
import HeartbeatReceptivo from "./components/HeartbeatReceptivo";
import NotificacoesSupervisaoAdm from "./components/NotificacoesSupervisaoAdm";
import GestaoFinanceiraOperadores from "./pages/GestaoFinanceiraOperadores";
import ProjecaoHoraHora from "./pages/ProjecaoHoraHora";
import DRE from "./pages/DRE";
import ImportarRecuperacao from "./pages/ImportarRecuperacao";
import ExecutivoRecuperacao from "./pages/ExecutivoRecuperacao";
import MeuDashboard from "./pages/MeuDashboard";
import ElogiosAtendimento from "./pages/ElogiosAtendimento";
import ExportarContatos from "./pages/ExportarContatos";
import AcoesMassivas from "./pages/AcoesMassivas";
import HistoricoRecuperacao from "./pages/HistoricoRecuperacao";
import SaudeDaBase from "./pages/SaudeDaBase";
import TvElogios from "./pages/TvElogios";
import TaxaConversao from "./pages/TaxaConversao";
import PainelGeral from "./pages/PainelGeral";
function EmDesenvolvimento({ titulo }) {
  return (
    <div className="main">
      <h1>{titulo}</h1>
      <p>Esta funcionalidade está em desenvolvimento no ReATIVA.</p>
    </div>
  );
}
function podeAcessar(perfil, rota) {
  const permissoes = {
    gerencia: [
      "/",
      "/minha-fila",
      "/agenda",
      "/agenda-operacional",
      "/aluno",
      "/crm",
      "/financeiro",
      "/financeiro-hub",
      "/base-analitica",
      "/termos-adm",
      "/borderos",
      "/vincular-operadores",
      "/importacoes",
      "/usuarios",
      "/relatorios",
      "/configuracoes",
      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/fila-confirmacao-pagamento",
      "/painel-adm",
      "/painel-geral",
      "/fila-financeiro",
      "/painel-operadores",
      "/financeiro-operadores",
      "/meu-perfil",
      "/painel-carteira",
      "/elogios-atendimento",
      "/projecao-hora-a-hora",
      "/exportar-contatos",
      "/acoes-massivas",
      "/historico-recuperacao",
      "/saude-da-base",
      "/taxa-conversao",],
    supervisor: [
      "/",
      "/minha-fila",
      "/agenda",
      "/agenda-operacional",
      "/aluno",
      "/crm",
      "/financeiro",
      "/financeiro-hub",
      "/base-analitica",
      "/termos-adm",
      "/relatorios",
      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/fila-confirmacao-pagamento",
      "/painel-adm",
      "/painel-geral",
      "/fila-financeiro",
      "/meu-perfil",
      "/painel-carteira",
      "/elogios-atendimento",
      "/projecao-hora-a-hora",
      "/exportar-contatos",
      "/acoes-massivas",
      "/historico-recuperacao",
      "/saude-da-base",
      "/taxa-conversao",],
    administrativo: [
      "/",
      "/minha-fila",
      "/agenda",
      "/agenda-operacional",
      "/aluno",
      "/crm",
      "/financeiro",
      "/financeiro-hub",
      "/termos-adm",
      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/fila-confirmacao-pagamento",
      "/painel-adm",
      "/fila-financeiro",
      "/borderos",
      "/vincular-operadores",
      "/meu-perfil",
      "/painel-carteira",
      "/meu-dashboard",
      "/elogios-atendimento",
      "/projecao-hora-a-hora",],
    operador: [
      "/",
      "/minha-fila",
      "/aluno",
      "/crm",
      "/agenda",
      "/agenda-operacional",
      "/relatorios",
      "/meu-perfil",
      "/painel-carteira",
      "/meu-dashboard",
      "/elogios-atendimento",
      "/projecao-hora-a-hora",],
  };
  return permissoes[perfil]?.includes(rota);
}
// Gerenciar usuários é mais sensível que o resto do que "gerencia" acessa
// -- fica restrito só a essas pessoas, nem todo mundo com perfil gerencia.
const EMAILS_PODE_GERIR_USUARIOS = [
  "amanda.seibel@aelbra.com.br",
  "amandaseibel1706@gmail.com",
  "amandapradoseibel@gmail.com",
  "cobranca04@aelbra.com.br", // Fernanda (supervisora)
];
function RotaProtegida({ usuario, rota, children }) {
  const perfil = usuario?.perfil?.perfil;
  if (!podeAcessar(perfil, rota)) {
    return <Navigate to="/" replace />;
  }
  if (rota === "/usuarios") {
    const email = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
    if (!EMAILS_PODE_GERIR_USUARIOS.includes(email)) {
      return <Navigate to="/" replace />;
    }
  }
  return children;
}
export default function App() {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [linksAguardando, setLinksAguardando] = useState(0);
  const [termosRejeitados, setTermosRejeitados] = useState(0);
  const [termosAguardandoValidacao, setTermosAguardandoValidacao] = useState(0);
  const [baixasAguardando, setBaixasAguardando] = useState(0);
  const [elogiosPendentes, setElogiosPendentes] = useState(0);
  const [tema, setTema] = useState("claro"); // tema fixo claro
  const [sidebarRecolhida, setSidebarRecolhida] = useState(() => {
    return localStorage.getItem("reativa_sidebar_recolhida") === "1";
  });
  function alternarSidebar() {
    setSidebarRecolhida((atual) => {
      const novo = !atual;
      localStorage.setItem("reativa_sidebar_recolhida", novo ? "1" : "0");
      return novo;
    });
  }
  function alternarTema() {
    const novoTema = tema === "escuro" ? "claro" : "escuro";
    setTema(novoTema);
    localStorage.setItem("reativa_tema", novoTema);
  }
  useEffect(() => {
    verificarSessao();
  }, []);
  useEffect(() => {
    const perfilAtual = usuario?.perfil?.perfil;
    if (!usuario || !podeAcessar(perfilAtual, "/painel-adm")) {
      setLinksAguardando(0);
      return;
    }
    let ativo = true;
    async function carregarPendentes() {
      const { count, error } = await supabase
        .from("links_pagamento")
        .select("id", { count: "exact", head: true })
        .in("status", ["SOLICITADO_LINK", "LINK_EM_ATENDIMENTO"]);
      if (ativo && !error) {
        setLinksAguardando(count || 0);
      }
    }
    carregarPendentes();
    const intervalo = setInterval(carregarPendentes, 15000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, [usuario]);
  useEffect(() => {
    const email = (usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase();
    const ehGestao = ["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br"].includes(email);
    if (!usuario || !ehGestao) {
      setTermosAguardandoValidacao(0);
      return;
    }
    let ativo = true;
    async function carregarTermosAguardando() {
      const { count, error } = await supabase
        .from("termos_acordo")
        .select("id", { count: "exact", head: true })
        .eq("status", "TERMO_ENVIADO_ADM");
      if (ativo && !error) {
        setTermosAguardandoValidacao(count || 0);
      }
    }
    carregarTermosAguardando();
    const intervalo = setInterval(carregarTermosAguardando, 15000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, [usuario]);
  // Comprovantes anexados esperando a Amanda dar baixa (Fila de Baixas).
  useEffect(() => {
    const perfilAtual = usuario?.perfil?.perfil;
    if (!usuario || !podeAcessar(perfilAtual, "/minha-fila-pagamentos")) {
      setBaixasAguardando(0);
      return;
    }
    let ativo = true;
    async function carregarBaixasPendentes() {
      const { count, error } = await supabase
        .from("links_pagamento")
        .select("id", { count: "exact", head: true })
        .eq("status", "AGUARDANDO_BAIXA");
      if (ativo && !error) {
        setBaixasAguardando(count || 0);
      }
    }
    carregarBaixasPendentes();
    const intervalo = setInterval(carregarBaixasPendentes, 15000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, [usuario]);
  // Elogios de atendimento ainda sem decisão (nem aprovados, nem rejeitados
  // pra TV) -- avisa na aba pra não depender de ninguém sinalizar.
  useEffect(() => {
    const perfilAtual = usuario?.perfil?.perfil;
    if (!usuario || !podeAcessar(perfilAtual, "/elogios-atendimento")) {
      setElogiosPendentes(0);
      return;
    }
    let ativo = true;
    async function carregarElogiosPendentes() {
      const { count, error } = await supabase
        .from("elogios_atendimento")
        .select("id", { count: "exact", head: true })
        .eq("status", "PENDENTE_ANALISE");
      if (ativo && !error) {
        setElogiosPendentes(count || 0);
      }
    }
    carregarElogiosPendentes();
    const intervalo = setInterval(carregarElogiosPendentes, 15000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, [usuario]);
  useEffect(() => {
    const email = usuario?.auth?.email || usuario?.perfil?.email;
    if (!usuario || !email) {
      setTermosRejeitados(0);
      return;
    }
    let ativo = true;
    async function carregarTermosRejeitados() {
      const { data, error } = await supabase
        .from("termos_acordo")
        .select("aluno_id, status, criado_em")
        .eq("operador_email", email)
        .order("criado_em", { ascending: false });
      if (!ativo || error || !data) return;
      // Para cada aluno, olha só o termo mais recente enviado por mim.
      // Se o mais recente foi rejeitado, ainda precisa de correção.
      const maisRecentePorAluno = new Map();
      for (const termo of data) {
        if (!maisRecentePorAluno.has(termo.aluno_id)) {
          maisRecentePorAluno.set(termo.aluno_id, termo.status);
        }
      }
      let total = 0;
      for (const status of maisRecentePorAluno.values()) {
        if (status === "TERMO_REJEITADO") total += 1;
      }
      setTermosRejeitados(total);
    }
    carregarTermosRejeitados();
    const intervalo = setInterval(carregarTermosRejeitados, 15000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, [usuario]);
  async function verificarSessao() {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      const email = data.session.user.email;
      const { data: perfil } = await supabase
        .from("usuarios")
        .select("*")
        .eq("email", email)
        .eq("ativo", true)
        .single();
      if (perfil) {
        setUsuario({
          auth: data.session.user,
          perfil,
        });
        registrarLoginSeNecessario(perfil.email, perfil.nome);
      } else {
        await supabase.auth.signOut();
        setUsuario(null);
      }
    }
    setCarregando(false);
  }
  async function sair() {
    const email = usuario?.perfil?.email || usuario?.auth?.email;
    const nome = usuario?.perfil?.nome;
    await registrarLogout(email, nome);
    if (email) await supabase.rpc("fila_receptivo_sair", { p_email: email });
    await supabase.auth.signOut();
    window.location.href = "/";
  }
  if (carregando) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          background: "#0f172a",
          color: "#fff",
          fontSize: 22,
        }}
      >
        Carregando ReATIVA...
      </div>
    );
  }
  if (window.location.pathname === "/redefinir-senha") {
    return <RedefinirSenha />;
  }
  if (!usuario) {
    return <Login onLogin={setUsuario} />;
  }
  if (window.location.pathname === "/tv-elogios") {
    return <TvElogios />;
  }
  if (usuario.perfil?.deve_trocar_senha) {
    return <RedefinirSenha forcado email={usuario.perfil.email} />;
  }
  const perfil = usuario.perfil?.perfil;
  const menuBase = [
    { rota: "/dre", label: "DRE (gerencia)" },
    { rota: "/importar-recuperacao", label: "📥 Importar Recuperação" },
  { rota: "/executivo", label: "📊 Visão Executiva" },
    {
      rota: "/",
      label: perfil === "operador" ? "Minha Fila" : "Dashboard",
      icone: perfil === "operador" ? "Zap" : "LayoutDashboard",
      secao: "Operação",
      esconderParaOperador: true,
    },
    { rota: "/painel-carteira", label: "Minha Carteira", icone: "Folder", secao: "Operação" },
    {
      rota: "/minha-fila",
      label: "Fila Operacional",
      icone: "Zap",
      secao: "Operação",
      esconderParaOperador: true,
    },
    { rota: "/agenda", label: "Agenda Operacional", icone: "Calendar", secao: "Operação" },
    { rota: "/aluno", label: "Aluno", icone: "User", secao: "Operação" },
    { rota: "/elogios-atendimento", label: "Elogios de Atendimento", icone: "Heart", secao: "Operação" },
    { rota: "/financeiro-hub", label: "Financeiro", icone: "DollarSign", secao: "Financeiro" },
    { rota: "/central-pagamentos", label: "Central de Pagamentos", icone: "Wallet", secao: "Financeiro" },
    { rota: "/painel-geral", label: "Painel Geral", icone: "LayoutPanelTop", secao: "Gestão" },
    { rota: "/meu-dashboard", label: "Meu Dashboard", icone: "BarChart3", secao: "Gestão" },
    { rota: "/projecao-hora-a-hora", label: "Projeção Hora a Hora", icone: "Clock", secao: "Gestão" },
    { rota: "/exportar-contatos", label: "Exportar Contatos", icone: "Contact", secao: "Gestão" },
    { rota: "/acoes-massivas", label: "Ações Massivas", icone: "Zap", secao: "Gestão" },
    { rota: "/historico-recuperacao", label: "Histórico da Recuperação", icone: "TrendingUp", secao: "Gestão" },
    { rota: "/saude-da-base", label: "Saúde da Base", icone: "CheckCircle2", secao: "Gestão" },
    { rota: "/taxa-conversao", label: "Taxa de Conversão", icone: "TrendingUp", secao: "Gestão" },
    { rota: "/vincular-operadores", label: "Vincular Operadores", icone: "Link2", secao: "Gestão" },
    { rota: "/financeiro-operadores", label: "Financeiro Operadores", icone: "Lock", secao: "Gestão" },
    { rota: "/relatorios", label: "Relatórios", icone: "TrendingUp", secao: "Gestão" },
    { rota: "/importacoes", label: "Importações", icone: "Upload", secao: "Configurações" },
    { rota: "/usuarios", label: "Usuários", icone: "Users", secao: "Configurações" },
    { rota: "/configuracoes", label: "Configurações", icone: "Settings", secao: "Configurações" },
    { rota: "/meu-perfil", label: "Meu Perfil", icone: "UserCircle", secao: "Configurações" },
  ];
  const menu = menuBase.filter((item) => {
    if (perfil === "operador" && item.esconderParaOperador) return false;
    if (item.rota === "/dre") {
      const em = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
      return em === "amanda.seibel@aelbra.com.br";
    }
    if (item.rota === "/importar-recuperacao") {
      const em2 = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
      return ["amanda.seibel@aelbra.com.br","cobranca04@aelbra.com.br","cobranca07@aelbra.com.br"].includes(em2);
    }
    if (item.rota === "/executivo") {
      const em3 = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
      return ["amanda.seibel@aelbra.com.br","cobranca04@aelbra.com.br","cobranca07@aelbra.com.br"].includes(em3);
    }
    if (item.rota === "/") {
      const email = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
      if (["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br"].includes(email)) return false;
    }
    if (item.rota === "/usuarios") {
      const email = String(usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase().trim();
      if (!EMAILS_PODE_GERIR_USUARIOS.includes(email)) return false;
    }
    return podeAcessar(perfil, item.rota);
  });
  return (
    <BrowserRouter>
      <div className="app" data-tema={tema}>
        <HeartbeatReceptivo usuario={usuario} />
        <AutoLogout usuario={usuario} />
        <NotificacoesSupervisaoAdm usuario={usuario} />
        <aside className={sidebarRecolhida ? "sidebar sidebar-recolhida" : "sidebar"}>
          <button
            type="button"
            className="botao-recolher-sidebar"
            onClick={alternarSidebar}
            title={sidebarRecolhida ? "Expandir menu" : "Recolher menu (útil pra usar em tela dividida)"}
          >
            {sidebarRecolhida ? "»" : "«"}
          </button>
          <div className="cabecalho-usuario">
            <h2 className="marca-reativa">{sidebarRecolhida ? (<><span style={{ color: "#3b82f6" }}>R</span>A</>) : (<><span style={{ color: "#3b82f6" }}>Re</span>ATIVA</>)}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
              {usuario.perfil?.foto_url ? (
                <img
                  src={usuario.perfil.foto_url}
                  alt="Foto"
                  style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }}
                />
              ) : null}
              <span>{usuario.perfil?.apelido || usuario.perfil?.nome}</span>
            </div>
            <small
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: "3px 10px",
                borderRadius: 999,
                background: "rgba(37,99,235,0.12)",
                border: "1px solid rgba(37,99,235,0.35)",
                color: "#60a5fa",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {usuario.perfil?.perfil}
            </small>
            <button
              style={{
                marginTop: 18,
                width: "100%",
                padding: "9px 10px",
                borderRadius: 10,
                border: "1px solid rgba(239,68,68,0.35)",
                background: "rgba(239,68,68,0.08)",
                color: "#f87171",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13,
              }}
              onClick={sair}
            >
              Sair
            </button>
          </div>
          <nav>
            {menu.map((item, indice) => {
              const IconeComponente = ICONES_MENU[item.icone] || Zap;
              const secaoAnterior = indice > 0 ? menu[indice - 1].secao : null;
              const mostrarTituloSecao = item.secao && item.secao !== secaoAnterior && !sidebarRecolhida;
              return (
                <div key={item.rota}>
                  {mostrarTituloSecao && (
                    <div className="sidebar-secao-titulo">{item.secao}</div>
                  )}
                  <NavLink
                    to={item.rota}
                    end={item.rota === "/"}
                    title={sidebarRecolhida ? item.label : undefined}
                  >
                    <IconeComponente size={17} strokeWidth={2} style={{ flexShrink: 0 }} />
                    {!sidebarRecolhida && <span>{item.label}</span>}
                {item.rota === "/financeiro-hub" && (linksAguardando + termosAguardandoValidacao) > 0 && (
                  <span
                    className="badge-pendente"
                    title={`${linksAguardando} link(s) aguardando resposta · ${termosAguardandoValidacao} termo(s) aguardando validação`}
                  >
                    {linksAguardando + termosAguardandoValidacao}
                  </span>
                )}
                {item.rota === "/aluno" && termosRejeitados > 0 && (
                  <span
                    className="badge-alerta"
                    title="Termos de acordo rejeitados aguardando correção"
                  >
                    {termosRejeitados}
                  </span>
                )}
                {item.rota === "/minha-fila-pagamentos" && baixasAguardando > 0 && (
                  <span
                    className="badge-pendente"
                    title="Comprovantes aguardando baixa"
                  >
                    {baixasAguardando}
                  </span>
                )}
                {item.rota === "/elogios-atendimento" && elogiosPendentes > 0 && (
                  <span
                    className="badge-pendente"
                    title="Elogios aguardando aprovação para a TV"
                  >
                    {elogiosPendentes}
                  </span>
                )}
                  </NavLink>
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="content">
      <Routes>
            <Route
              path="/"
              element={
                perfil === "operador" ? (
                  <Navigate to="/painel-carteira" replace />
                ) : ["amanda.seibel@aelbra.com.br", "cobranca04@aelbra.com.br"].includes(
                    (usuario?.perfil?.email || usuario?.auth?.email || "").toLowerCase()
                  ) ? (
                  <Navigate to="/projecao-hora-a-hora" replace />
                ) : (
                  <Dashboard />
                )
              }
            />
            <Route
              path="/minha-fila"
              element={
                perfil === "operador" ? (
                  <Navigate to="/painel-carteira" replace />
                ) : (
                  <RotaProtegida usuario={usuario} rota="/minha-fila">
                    <MinhaFila />
                  </RotaProtegida>
                )
              }
            />
            <Route
              path="/aluno"
              element={
                <RotaProtegida usuario={usuario} rota="/aluno">
                  <Aluno />
                </RotaProtegida>
              }
            />
            <Route
              path="/crm"
              element={
                <RotaProtegida usuario={usuario} rota="/crm">
                  <CRM />
                </RotaProtegida>
              }
            />
            <Route
              path="/financeiro"
              element={
                <RotaProtegida usuario={usuario} rota="/financeiro">
                  <ConsultaFinanceira />
                </RotaProtegida>
              }
            />
            <Route
              path="/base-analitica"
              element={
                <RotaProtegida usuario={usuario} rota="/base-analitica">
                  <BaseAnalitica />
                </RotaProtegida>
              }
            />
            <Route
              path="/termos-adm"
              element={
                <RotaProtegida usuario={usuario} rota="/termos-adm">
                  <FilaTermos />
                </RotaProtegida>
              }
            />
            <Route
              path="/borderos"
              element={
                <RotaProtegida usuario={usuario} rota="/borderos">
                  <Borderos />
                </RotaProtegida>
              }
            />
            <Route
              path="/vincular-operadores"
              element={
                <RotaProtegida usuario={usuario} rota="/vincular-operadores">
                  <VincularBaseOperacional />
                </RotaProtegida>
              }
            />
            <Route
              path="/importacoes"
              element={
                <RotaProtegida usuario={usuario} rota="/importacoes">
                  <Importacoes />
                </RotaProtegida>
              }
            />
            <Route
              path="/usuarios"
              element={
                <RotaProtegida usuario={usuario} rota="/usuarios">
                  <Usuarios />
                </RotaProtegida>
              }
            />
            <Route
              path="/relatorios"
              element={
                <RotaProtegida usuario={usuario} rota="/relatorios">
                  <RelatorioTabulacoes />
                </RotaProtegida>
              }
            />
            <Route
              path="/configuracoes"
              element={
                <RotaProtegida usuario={usuario} rota="/configuracoes">
                  <EmDesenvolvimento titulo="Configurações" />
                </RotaProtegida>
              }
            />
            <Route
              path="/agenda"
              element={
                <RotaProtegida usuario={usuario} rota="/agenda">
                  <AgendaOperacional />
                </RotaProtegida>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
                  <Route path="/fila-adm-termos" element={<FilaAdmTermos />} />
              <Route path="/base-receptiva" element={<BaseReceptiva />} />
              {/* Fila Operacional (rota antiga): operador e redirecionado para
                  a Minha Carteira; demais perfis mantem o acesso atual. */}
              <Route
                path="/fila-operacional"
                element={
                  perfil === "operador" ? (
                    <Navigate to="/painel-carteira" replace />
                  ) : (
                    <FilaOperacional />
                  )
                }
              />
              <Route path="/controle-links-pagamento" element={<ControleLinksPagamento />} />
              <Route path="/painel-adm" element={<PainelAdm />} />
              <Route path="/painel-geral" element={<PainelGeral />} />
              <Route path="/financeiro-hub" element={<FinanceiroHub />} />
        <Route path="/central-pagamentos" element={<CentralPagamentos />} />
              <Route path="/fila-financeiro" element={<FilaFinanceiro />} />
              <Route path="/fila-confirmacao-pagamento" element={<FilaConfirmacaoPagamento />} />
              <Route path="/painel-operadores" element={<PainelOperadores />} />
              <Route path="/meu-perfil" element={<MeuPerfil />} />
            <Route
              path="/financeiro-operadores"
              element={
                <RotaProtegida usuario={usuario} rota="/financeiro-operadores">
                  <GestaoFinanceiraOperadores />
                </RotaProtegida>
              }
            />
              <Route path="/minha-fila-pagamentos" element={<MinhaFilaPagamentos />} />
              <Route path="/painel-carteira" element={<PainelCarteira />} />
              <Route path="/meu-dashboard" element={<MeuDashboard />} />
              <Route path="/elogios-atendimento" element={<ElogiosAtendimento />} />
              <Route path="/exportar-contatos" element={<ExportarContatos />} />
              <Route path="/acoes-massivas" element={<AcoesMassivas />} />
              <Route path="/historico-recuperacao" element={<HistoricoRecuperacao />} />
        <Route path="/executivo" element={<ExecutivoRecuperacao />} />
              <Route path="/saude-da-base" element={<SaudeDaBase />} />
              <Route path="/taxa-conversao" element={<TaxaConversao />} />
              <Route path="/projecao-hora-a-hora" element={<ProjecaoHoraHora />} />
              <Route path="/agenda-operacional" element={<AgendaOperacional />} />
              <Route path="/minha-fila-quitacao" element={<MinhaFilaQuitacao />} />
              <Route path="/dre" element={<DRE />} />
              <Route path="/importar-recuperacao" element={<ImportarRecuperacao />} />
              <Route path="/manual-operacao" element={<ManualOperacao />} />
      </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
