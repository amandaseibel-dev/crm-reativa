import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const perfis = ["admin", "supervisor", "operador"];

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");

  const [form, setForm] = useState({
    nome: "",
    email: "",
    perfil: "operador",
    operador_nome: "",
    operador: "",
    ativo: true,
  });

  useEffect(() => {
    carregarUsuarios();
  }, []);

  async function carregarUsuarios() {
    setErro("");

    const { data, error } = await supabase
      .from("usuarios")
      .select("*")
      .order("nome", { ascending: true });

    if (error) {
      setErro("Erro ao carregar usuários.");
      return;
    }

    setUsuarios(data || []);
  }

  function atualizarCampo(campo, valor) {
    setForm((atual) => ({
      ...atual,
      [campo]: valor,
    }));
  }

  function limparFormulario() {
    setForm({
      nome: "",
      email: "",
      perfil: "operador",
      operador_nome: "",
      operador: "",
      ativo: true,
    });
  }

  async function salvarUsuario(e) {
    e.preventDefault();

    setErro("");
    setMensagem("");
    setCarregando(true);

    const nome = form.nome.trim();
    const email = form.email.trim().toLowerCase();
    const operadorNome = form.operador_nome.trim() || nome;
    const operador = form.operador.trim().toUpperCase() || nome.toUpperCase();

    if (!nome || !email) {
      setErro("Preencha nome e e-mail.");
      setCarregando(false);
      return;
    }

    const { error } = await supabase.from("usuarios").upsert(
      {
        nome,
        email,
        perfil: form.perfil,
        ativo: form.ativo,
        operador_nome: operadorNome,
        operador,
      },
      { onConflict: "email" }
    );

    setCarregando(false);

    if (error) {
      console.error(error);
      setErro("Falhou ao salvar usuário no CRM.");
      return;
    }

    setMensagem("Usuário salvo no CRM com sucesso.");
    limparFormulario();
    carregarUsuarios();
  }

  async function alternarAtivo(usuario) {
    setErro("");
    setMensagem("");

    const { error } = await supabase
      .from("usuarios")
      .update({ ativo: !usuario.ativo })
      .eq("email", usuario.email);

    if (error) {
      setErro("Erro ao alterar status do usuário.");
      return;
    }

    carregarUsuarios();
  }

  async function excluirUsuario(usuario) {
    const confirmar = window.confirm(
      `Deseja remover ${usuario.nome} da tabela de usuários do CRM?`
    );

    if (!confirmar) return;

    const { error } = await supabase
      .from("usuarios")
      .delete()
      .eq("email", usuario.email);

    if (error) {
      setErro("Erro ao remover usuário.");
      return;
    }

    carregarUsuarios();
  }

  function editarUsuario(usuario) {
    setMensagem("");
    setErro("");

    setForm({
      nome: usuario.nome || "",
      email: usuario.email || "",
      perfil: usuario.perfil || "operador",
      operador_nome: usuario.operador_nome || usuario.nome || "",
      operador: usuario.operador || "",
      ativo: usuario.ativo ?? true,
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div style={{ padding: 24, color: "#fff" }}>
      <h1 style={{ marginBottom: 6, color: "#c084fc" }}>Usuários</h1>

      <p style={{ color: "#ddd6fe", marginBottom: 22 }}>
        Cadastro de perfis autorizados no ReATIVA One.
      </p>

      <div
        style={{
          background: "#16002e",
          border: "1px solid #7e22ce",
          borderRadius: 16,
          padding: 20,
          marginBottom: 24,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Cadastrar / atualizar usuário</h2>

        <form onSubmit={salvarUsuario}>
          <div style={grid}>
            <div>
              <label style={label}>Nome</label>
              <input
                style={input}
                value={form.nome}
                onChange={(e) => atualizarCampo("nome", e.target.value)}
                placeholder="Ex: Olga"
              />
            </div>

            <div>
              <label style={label}>E-mail</label>
              <input
                style={input}
                type="email"
                value={form.email}
                onChange={(e) => atualizarCampo("email", e.target.value)}
                placeholder="cobranca03@aelbra.com.br"
              />
            </div>

            <div>
              <label style={label}>Perfil</label>
              <select
                style={input}
                value={form.perfil}
                onChange={(e) => atualizarCampo("perfil", e.target.value)}
              >
                {perfis.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={label}>Operador nome</label>
              <input
                style={input}
                value={form.operador_nome}
                onChange={(e) =>
                  atualizarCampo("operador_nome", e.target.value)
                }
                placeholder="Ex: Olga"
              />
            </div>

            <div>
              <label style={label}>Operador</label>
              <input
                style={input}
                value={form.operador}
                onChange={(e) => atualizarCampo("operador", e.target.value)}
                placeholder="Ex: OLGA"
              />
            </div>

            <div>
              <label style={label}>Status</label>
              <select
                style={input}
                value={form.ativo ? "true" : "false"}
                onChange={(e) =>
                  atualizarCampo("ativo", e.target.value === "true")
                }
              >
                <option value="true">Ativo</option>
                <option value="false">Inativo</option>
              </select>
            </div>
          </div>

          {erro && <p style={{ color: "#f87171", fontWeight: 800 }}>{erro}</p>}
          {mensagem && (
            <p style={{ color: "#22c55e", fontWeight: 800 }}>{mensagem}</p>
          )}

          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button type="submit" disabled={carregando} style={botaoVerde}>
              {carregando ? "Salvando..." : "Salvar usuário"}
            </button>

            <button type="button" onClick={limparFormulario} style={botaoRoxo}>
              Limpar
            </button>
          </div>
        </form>
      </div>

      <div
        style={{
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 16,
          padding: 20,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Usuários cadastrados</h2>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#2e1065" }}>
                <th style={th}>Nome</th>
                <th style={th}>E-mail</th>
                <th style={th}>Perfil</th>
                <th style={th}>Operador</th>
                <th style={th}>Status</th>
                <th style={th}>Ações</th>
              </tr>
            </thead>

            <tbody>
              {usuarios.map((u) => (
                <tr key={u.email} style={{ borderBottom: "1px solid #334155" }}>
                  <td style={td}>{u.nome}</td>
                  <td style={td}>{u.email}</td>
                  <td style={td}>{u.perfil}</td>
                  <td style={td}>{u.operador}</td>
                  <td style={td}>{u.ativo ? "Ativo" : "Inativo"}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => editarUsuario(u)} style={miniBtn}>
                        Editar
                      </button>

                      <button
                        onClick={() => alternarAtivo(u)}
                        style={miniBtn}
                      >
                        {u.ativo ? "Inativar" : "Ativar"}
                      </button>

                      <button
                        onClick={() => excluirUsuario(u)}
                        style={miniBtnVermelho}
                      >
                        Remover
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {usuarios.length === 0 && (
                <tr>
                  <td style={td} colSpan="6">
                    Nenhum usuário cadastrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p style={{ color: "#facc15", marginTop: 18, fontWeight: 700 }}>
        Importante: esta tela libera o perfil no CRM. O login no Supabase
        Authentication ainda precisa existir para o e-mail.
      </p>
    </div>
  );
}

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 14,
};

const label = {
  display: "block",
  marginBottom: 6,
  fontWeight: 800,
  color: "#ddd6fe",
};

const input = {
  width: "100%",
  padding: 12,
  borderRadius: 10,
  border: "1px solid #7e22ce",
  fontWeight: 700,
};

const botaoVerde = {
  background: "#22c55e",
  color: "#020617",
  border: "none",
  borderRadius: 12,
  padding: "12px 18px",
  fontWeight: 900,
  cursor: "pointer",
};

const botaoRoxo = {
  background: "#7e22ce",
  color: "#fff",
  border: "none",
  borderRadius: 12,
  padding: "12px 18px",
  fontWeight: 900,
  cursor: "pointer",
};

const th = {
  padding: 10,
  textAlign: "left",
  color: "#ddd6fe",
};

const td = {
  padding: 10,
};

const miniBtn = {
  background: "#a855f7",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "7px 9px",
  fontWeight: 800,
  cursor: "pointer",
};

const miniBtnVermelho = {
  background: "#ef4444",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "7px 9px",
  fontWeight: 800,
  cursor: "pointer",
};