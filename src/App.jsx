import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { supabase } from "./services/supabase";

import Dashboard from "./pages/Dashboard";
import BaseAnalitica from "./pages/BaseAnalitica";
import Aluno from "./pages/Aluno";
import CRM from "./pages/CRM";
import Login from "./pages/Login";
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
import PainelOperadores from "./pages/PainelOperadores";
import { registrarLoginSeNecessario, registrarLogout } from "./utils/ponto";
import PainelAdm from "./pages/PainelAdm";

function EmDesenvolvimento({ titulo }) {
  return (
    <div className="main">
      <h1>{titulo}</h1>
      <p>Esta funcionalidade está em desenvolvimento no ReATIVA One.</p>
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
      "/base-analitica",
      "/termos-adm",
      "/borderos",
      "/importacoes",
      "/usuarios",
      "/relatorios",
      "/configuracoes",

      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/painel-adm",
      "/fila-financeiro",
      "/painel-operadores",    ],
    supervisor: [
      "/",
      "/minha-fila",
      "/agenda",
      "/agenda-operacional",
      "/aluno",
      "/crm",
      "/financeiro",
      "/base-analitica",
      "/termos-adm",
      "/relatorios",

      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/painel-adm",
      "/fila-financeiro",    ],
    administrativo: [
      "/",
      "/minha-fila",
      "/agenda",
      "/agenda-operacional",
      "/aluno",
      "/crm",
      "/financeiro",
      "/termos-adm",

      "/controle-links-pagamento",
      "/minha-fila-pagamentos",
      "/painel-adm",
      "/fila-financeiro",    ],
    operador: [
      "/",
      "/minha-fila",
      "/aluno",
      "/crm",
      "/agenda",
      "/agenda-operacional",
    ],
  };

  return permissoes[perfil]?.includes(rota);
}

function RotaProtegida({ usuario, rota, children }) {
  const perfil = usuario?.perfil?.perfil;

  if (!podeAcessar(perfil, rota)) {
    return <Navigate to="/" replace />;
  }

  return children;
}

export default function App() {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [linksAguardando, setLinksAguardando] = useState(0);
  const [termosRejeitados, setTermosRejeitados] = useState(0);

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
        Carregando ReATIVA One...
      </div>
    );
  }

  if (!usuario) {
    return <Login onLogin={setUsuario} />;
  }

  const perfil = usuario.perfil?.perfil;

  const menuBase = [
    {
      rota: "/",
      label: perfil === "operador" ? "⚡ Minha Fila" : "🏠 Dashboard",
    },
    {
      rota: "/minha-fila",
      label: "⚡ Fila Operacional",
      esconderParaOperador: true,
    },
    { rota: "/agenda", label: "📅 Agenda Operacional" },
    { rota: "/aluno", label: "👤 Aluno" },
    { rota: "/crm", label: "📞 CRM Operacional" },
    { rota: "/financeiro", label: "💰 Financeiro" },
    { rota: "/controle-links-pagamento", label: "🔗 Fila de Links" },
    { rota: "/painel-adm", label: "📊 Painel ADM" },
    { rota: "/fila-financeiro", label: "🏦 Fila Financeiro" },
    { rota: "/painel-operadores", label: "🕒 Painel Operadores" },
    { rota: "/minha-fila-pagamentos", label: "💳 Fila de Baixas" },
    { rota: "/base-analitica", label: "📊 Base Analítica" },
    { rota: "/termos-adm", label: "📎 Termos ADM" },
    { rota: "/borderos", label: "📑 Borderôs" },
    { rota: "/importacoes", label: "📥 Importações" },
    { rota: "/usuarios", label: "👥 Usuários" },
    { rota: "/relatorios", label: "📈 Relatórios" },
    { rota: "/configuracoes", label: "⚙️ Configurações" },
  ];

  const menu = menuBase.filter((item) => {
    if (perfil === "operador" && item.esconderParaOperador) return false;
    return podeAcessar(perfil, item.rota);
  });

  return (
    <BrowserRouter>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            <h2>ReATIVA One</h2>

            <span>{usuario.perfil?.nome}</span>

            <small
              style={{
                color: "#c084fc",
                marginTop: 6,
                display: "block",
                textTransform: "capitalize",
              }}
            >
              {usuario.perfil?.perfil}
            </small>

            <button
              style={{
                marginTop: 20,
                width: "100%",
                padding: 10,
                borderRadius: 10,
                border: "none",
                background: "#ef4444",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 800,
              }}
              onClick={sair}
            >
              Sair
            </button>
          </div>

          <nav>
            {menu.map((item) => (
              <NavLink key={item.rota} to={item.rota} end={item.rota === "/"}>
                {item.label}
                {item.rota === "/painel-adm" && linksAguardando > 0 && (
                  <span className="badge-pendente" title="Solicitações de link aguardando resposta">
                    {linksAguardando}
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
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="content">
          <BotaoManual />
      <Routes>
            <Route
              path="/"
              element={
                perfil === "operador" ? (
                  <MinhaFila />
                ) : (
                  <Dashboard />
                )
              }
            />

            <Route
              path="/minha-fila"
              element={
                <RotaProtegida usuario={usuario} rota="/minha-fila">
                  <MinhaFila />
                </RotaProtegida>
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
                  <EmDesenvolvimento titulo="Financeiro" />
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
                  <EmDesenvolvimento titulo="Borderôs" />
                </RotaProtegida>
              }
            />

            <Route
              path="/importacoes"
              element={
                <RotaProtegida usuario={usuario} rota="/importacoes">
                  <BaseAnalitica />
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
                  <EmDesenvolvimento titulo="Relatórios" />
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
              <Route path="/fila-operacional" element={<FilaOperacional />} />
              <Route path="/controle-links-pagamento" element={<ControleLinksPagamento />} />
              <Route path="/painel-adm" element={<PainelAdm />} />
              <Route path="/fila-financeiro" element={<FilaFinanceiro />} />
              <Route path="/painel-operadores" element={<PainelOperadores />} />
              <Route path="/minha-fila-pagamentos" element={<MinhaFilaPagamentos />} />
              <Route path="/agenda-operacional" element={<AgendaOperacional />} />
              <Route path="/minha-fila-quitacao" element={<MinhaFilaQuitacao />} />
              <Route path="/manual-operacao" element={<ManualOperacao />} />
      </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}