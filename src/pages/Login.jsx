import { useState } from "react";
import { supabase } from "../services/supabase";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  async function entrar(e) {
    e.preventDefault();

    setErro("");
    setCarregando(true);

    const emailNormalizado = email.trim().toLowerCase();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: emailNormalizado,
      password: senha,
    });

    if (error) {
      setCarregando(false);
      setErro("E-mail ou senha inválidos.");
      return;
    }

    const { data: perfil, error: erroPerfil } = await supabase
      .from("usuarios")
      .select("*")
      .eq("email", emailNormalizado)
      .eq("ativo", true)
      .single();

    setCarregando(false);

    if (erroPerfil || !perfil) {
      await supabase.auth.signOut();
      setErro("Usuário sem perfil ativo no ReATIVA One.");
      return;
    }

    onLogin({
      auth: data.user,
      perfil,
    });
  }

  return (
    <div style={page}>
      <section style={brand}>
        <div style={raio}>⚡</div>

        <h1 style={titulo}>
          Re<span style={{ color: "#a855f7" }}>ATIVA</span> One
        </h1>

        <h2 style={slogan}>A energia que gera resultados.</h2>

        <p style={texto}>
          Plataforma oficial de gestão operacional da ReATIVA.
          Organize a operação, acompanhe negociações e potencialize resultados.
        </p>

        <div style={cards}>
          <div style={card}>⚡ Energia</div>
          <div style={card}>🎯 Foco</div>
          <div style={card}>📈 Resultado</div>
        </div>
      </section>

      <section style={loginBox}>
        <h2 style={loginTitulo}>Entrar no sistema</h2>
        <p style={loginSub}>Acesso exclusivo da equipe ReATIVA</p>

        <form onSubmit={entrar}>
          <label style={label}>E-mail</label>
          <input
            style={input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="seu.email@aelbra.com.br"
            required
          />

          <label style={label}>Senha</label>
          <input
            style={input}
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="Digite sua senha"
            required
          />

          {erro && <p style={erroStyle}>{erro}</p>}

          <button type="submit" disabled={carregando} style={botao}>
            {carregando ? "Entrando..." : "⚡ Entrar"}
          </button>
        </form>

        <p style={rodape}>ReATIVA One © 2026</p>
      </section>
    </div>
  );
}

const page = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at 20% 20%, rgba(168,85,247,.35), transparent 30%), linear-gradient(135deg,#020617,#120022,#020617)",
  color: "#fff",
  display: "grid",
  gridTemplateColumns: "1.1fr .9fr",
  alignItems: "center",
  gap: 40,
  padding: 60,
  boxSizing: "border-box",
};

const brand = {
  maxWidth: 650,
};

const raio = {
  fontSize: 110,
  textShadow: "0 0 40px #a855f7",
  marginBottom: 20,
};

const titulo = {
  fontSize: 64,
  margin: 0,
  fontWeight: 950,
};

const slogan = {
  fontSize: 34,
  color: "#ddd6fe",
  marginTop: 14,
};

const texto = {
  fontSize: 18,
  lineHeight: 1.6,
  color: "#e9d5ff",
  maxWidth: 560,
};

const cards = {
  display: "flex",
  gap: 14,
  marginTop: 28,
  flexWrap: "wrap",
};

const card = {
  border: "1px solid #7e22ce",
  background: "rgba(15,23,42,.7)",
  borderRadius: 16,
  padding: "16px 20px",
  fontWeight: 900,
};

const loginBox = {
  background: "rgba(15,23,42,.86)",
  border: "1px solid #7e22ce",
  borderRadius: 26,
  padding: 42,
  boxShadow: "0 0 45px rgba(168,85,247,.25)",
};

const loginTitulo = {
  fontSize: 34,
  margin: 0,
};

const loginSub = {
  color: "#c4b5fd",
  marginBottom: 28,
};

const label = {
  display: "block",
  fontWeight: 800,
  marginBottom: 8,
};

const input = {
  width: "100%",
  padding: 15,
  borderRadius: 12,
  border: "1px solid #7e22ce",
  background: "#020617",
  color: "#fff",
  marginBottom: 18,
  fontWeight: 700,
  boxSizing: "border-box",
};

const botao = {
  width: "100%",
  padding: 16,
  border: "none",
  borderRadius: 14,
  background: "linear-gradient(90deg,#a855f7,#7e22ce)",
  color: "#fff",
  fontWeight: 950,
  fontSize: 16,
  cursor: "pointer",
};

const erroStyle = {
  color: "#fecaca",
  background: "rgba(127,29,29,.45)",
  border: "1px solid #ef4444",
  padding: 12,
  borderRadius: 12,
  fontWeight: 800,
};

const rodape = {
  textAlign: "center",
  color: "#a78bfa",
  marginTop: 24,
};