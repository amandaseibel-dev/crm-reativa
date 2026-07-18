import { useState } from "react";
import { supabase } from "../services/supabase";
import "./Login.css";

export default function Login() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  async function entrar(e) {
    e.preventDefault();
    setErro("");

    if (!email.trim() || !senha.trim()) {
      setErro("Informe usuário/e-mail e senha para acessar.");
      return;
    }

    try {
      setCarregando(true);

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: senha,
      });

      if (error) {
        setErro("Usuário ou senha inválidos. Confira os dados e tente novamente.");
        return;
      }

      window.location.href = "/";
    } catch (error) {
      setErro("Não foi possível acessar agora. Tente novamente.");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className="reativa-login">
      <section className="reativa-login__hero">
        <div className="reativa-login__brand">
          <div className="reativa-login__logo">
            <span>Re</span>ATIVA
          </div>
        </div>

        <div className="reativa-login__content">
          <div className="reativa-login__badge">
            RECUPERAÇÃO DE CRÉDITO
          </div>

          <h1>Gestão operacional com foco em resultado.</h1>

          <p>
            Centralize atendimentos, negociações, pagamentos, termos e histórico
            dos alunos em um único ambiente de trabalho.
          </p>

          <div className="reativa-login__flow">
            <div className="flow-card">
              <strong>Fila</strong>
              <span>Casos organizados</span>
            </div>

            <div className="flow-line" />

            <div className="flow-card destaque">
              <strong>Ação</strong>
              <span>Atendimento ativo</span>
            </div>

            <div className="flow-line" />

            <div className="flow-card">
              <strong>Resultado</strong>
              <span>Acordos e baixas</span>
            </div>
          </div>

          <div className="reativa-login__metrics">
            <div>
              <span>Operação 360°</span>
              <strong>Visão completa do aluno e do processo</strong>
            </div>

            <div>
              <span>Produtividade</span>
              <strong>Indicadores em tempo real</strong>
            </div>

            <div>
              <span>Gestão segura</span>
              <strong>Permissões por perfil e trilhas de auditoria</strong>
            </div>
          </div>
        </div>

        <div className="reativa-login__glow glow-one" />
        <div className="reativa-login__glow glow-two" />
      </section>

      <section className="reativa-login__access">
        <div className="login-wrapper">
          <form className="login-card" onSubmit={entrar}>
            <div className="login-card__top">
              <div>
                
                <h2>Entrar no ReATIVA</h2>
              </div>

              <div className="login-card__icon">🔒</div>
            </div>

            <p className="login-card__subtitle">
              Informe seu usuário corporativo para acessar sua fila de atendimento.
            </p>

            <label className="login-field">
              <span>Usuário / e-mail</span>
              <input
                type="email"
                placeholder="exemplo@aelbra.com.br"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>

            <label className="login-field">
              <span>Senha</span>

              <div className="password-box">
                <input
                  type={mostrarSenha ? "text" : "password"}
                  placeholder="Digite sua senha"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  autoComplete="current-password"
                />

                <button
                  type="button"
                  onClick={() => setMostrarSenha((atual) => !atual)}
                >
                  {mostrarSenha ? "Ocultar" : "Mostrar"}
                </button>
              </div>
            </label>

            {erro && <div className="login-error">{erro}</div>}

            <button className="login-button" type="submit" disabled={carregando}>
              {carregando ? "Acessando..." : "Acessar CRM"}
            </button>

            <div className="login-card__footer">
              <span>Ambiente seguro</span>
              <span>•</span>
              <span>Uso exclusivo da operação</span>
            </div>
          </form>

          <div className="login-side-panel">
            <div className="side-panel__header">
              <span>Status operacional</span>
              <strong>Online</strong>
            </div>

            <div className="side-panel__grid">
              <div className="side-panel__item">
                <span>Atendimentos</span>
                <strong>Fila ativa</strong>
              </div>

              <div className="side-panel__item">
                <span>Pagamentos</span>
                <strong>Em validação</strong>
              </div>

              <div className="side-panel__item">
                <span>Termos</span>
                <strong>Controle ADM</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
