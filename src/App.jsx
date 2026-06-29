import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { supabase } from "./services/supabase";

import Dashboard from "./pages/Dashboard";
import BaseAnalitica from "./pages/BaseAnalitica";
import Aluno from "./pages/Aluno";
import CRM from "./pages/CRM";
import Login from "./pages/Login";
import Usuarios from "./pages/Usuarios";

function EmDesenvolvimento({ titulo }) {
  return (
    <div className="main">
      <h1>{titulo}</h1>
      <p>Esta funcionalidade está em desenvolvimento no ReATIVA One.</p>
    </div>
  );
}

export default function App() {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    verificarSessao();
  }, []);

  async function verificarSessao() {
    const { data } = await supabase.auth.getSession();

    if (data.session) {
      const email = data.session.user.email;

      const { data: perfil } = await supabase
        .from("usuarios")
        .select("*")
        .eq("email", email)
        .single();

      if (perfil) {
        setUsuario({
          auth: data.session.user,
          perfil,
        });
      } else {
        await supabase.auth.signOut();
        setUsuario(null);
      }
    }

    setCarregando(false);
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
              }}
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}
            >
              Sair
            </button>
          </div>

          <nav>
            <NavLink to="/" end>
              🏠 Dashboard
            </NavLink>

            <NavLink to="/aluno">
              👤 Aluno
            </NavLink>

            <NavLink to="/crm">
              📞 CRM Operacional
            </NavLink>

            <NavLink to="/importacoes">
              📥 Importações
            </NavLink>

            <NavLink to="/financeiro">
              💰 Financeiro
            </NavLink>

            <NavLink to="/operacao">
              📋 Operação
            </NavLink>

            <NavLink to="/relatorios">
              📊 Relatórios
            </NavLink>

            <NavLink to="/configuracoes">
              ⚙️ Configurações
            </NavLink>

            <NavLink to="/usuarios">
              👥 Usuários
            </NavLink>
          </nav>
        </aside>

        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/aluno" element={<Aluno />} />
            <Route path="/crm" element={<CRM />} />
            <Route path="/importacoes" element={<BaseAnalitica />} />

            <Route
              path="/financeiro"
              element={<EmDesenvolvimento titulo="Financeiro" />}
            />

            <Route
              path="/operacao"
              element={<EmDesenvolvimento titulo="Operação" />}
            />

            <Route
              path="/relatorios"
              element={<EmDesenvolvimento titulo="Relatórios" />}
            />

            <Route
              path="/configuracoes"
              element={<EmDesenvolvimento titulo="Configurações" />}
            />

            <Route path="/usuarios" element={<Usuarios />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}