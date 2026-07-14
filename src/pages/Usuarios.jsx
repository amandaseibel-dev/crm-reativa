import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const perfis = ["gerencia", "supervisor", "administrativo", "operador"];

const senhaPadrao = "Reativa@2026";

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState([]);
  const [busca, setBusca] = useState("");
  const [filtroPerfil, setFiltroPerfil] = useState("todos");
  const [filtroStatus, setFiltroStatus] = useState("todos");
  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [carregando, setCarregando] = useState(false);

  const [form, setForm] = useState({
    nome: "",
    email: "",
    perfil: "operador",
    operador_nome: "",
    operador: "",
    ativo: true,
    receptivo: false,
    foto_url: "",
  });

  useEffect(() => {
    carregarUsuarios();
  }, []);

  async function carregarUsuarios() {
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

  function atualizar(campo, valor) {
    setForm((atual) => ({ ...atual, [campo]: valor }));
  }

  function limpar() {
    setForm({
      nome: "",
      email: "",
      perfil: "operador",
      operador_nome: "",
      operador: "",
      ativo: true,
      receptivo: false,
      foto_url: "",
    });
    setErro("");
    setMensagem("");
  }

  async function selecionarFoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setErro("A foto precisa ter no máximo 2MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      atualizar("foto_url", reader.result);
    };
    reader.readAsDataURL(file);
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
        receptivo: form.receptivo,
        operador_nome: operadorNome,
        operador,
        foto_url: form.foto_url || null,
      },
      { onConflict: "email" }
    );

    setCarregando(false);

    if (error) {
      console.error(error);
      setErro("Erro ao salvar usuário.");
      return;
    }

    setMensagem("Usuário salvo com sucesso.");
    limpar();
    carregarUsuarios();
  }

  function editarUsuario(u) {
    setForm({
      nome: u.nome || "",
      email: u.email || "",
      perfil: u.perfil || "operador",
      operador_nome: u.operador_nome || u.nome || "",
      operador: u.operador || "",
      ativo: u.ativo ?? true,
      receptivo: u.receptivo ?? false,
      foto_url: u.foto_url || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function alternarAtivo(u) {
    const { error } = await supabase
      .from("usuarios")
      .update({ ativo: !u.ativo })
      .eq("email", u.email);

    if (error) {
      setErro("Erro ao alterar status.");
      return;
    }

    carregarUsuarios();
  }

  async function alternarReceptivo(u) {
    const { error } = await supabase
      .from("usuarios")
      .update({ receptivo: !u.receptivo })
      .eq("email", u.email);

    if (error) {
      setErro("Erro ao alterar operador receptivo.");
      return;
    }

    carregarUsuarios();
  }

  async function removerUsuario(u) {
    const confirmar = window.confirm(`Remover ${u.nome} do CRM?`);
    if (!confirmar) return;

    const { error } = await supabase
      .from("usuarios")
      .delete()
      .eq("email", u.email);

    if (error) {
      setErro("Erro ao remover usuário.");
      return;
    }

    carregarUsuarios();
  }

  const usuariosFiltrados = useMemo(() => {
    return usuarios.filter((u) => {
      const texto = `${u.nome || ""} ${u.email || ""} ${u.operador || ""}`
        .toLowerCase();

      const bateBusca = texto.includes(busca.toLowerCase());
      const batePerfil = filtroPerfil === "todos" || u.perfil === filtroPerfil;
      const bateStatus =
        filtroStatus === "todos" ||
        (filtroStatus === "ativos" && u.ativo) ||
        (filtroStatus === "inativos" && !u.ativo);

      return bateBusca && batePerfil && bateStatus;
    });
  }, [usuarios, busca, filtroPerfil, filtroStatus]);

  const total = usuarios.length;
  const ativos = usuarios.filter((u) => u.ativo).length;
  const inativos = usuarios.filter((u) => !u.ativo).length;

  return (
    <div style={page}>
      <h1 style={title}>Usuários</h1>
      <p style={subtitle}>Gerencie os acessos e permissões do ReATIVA One.</p>

      <div style={cards}>
        <Card label="Total de usuários" value={total} />
        <Card label="Usuários ativos" value={ativos} />
        <Card label="Usuários inativos" value={inativos} />
        <Card label="Senha padrão" value={senhaPadrao} />
      </div>

      <section style={panel}>
        <h2 style={sectionTitle}>Novo usuário</h2>

        <form onSubmit={salvarUsuario}>
          <div style={formGrid}>
            <div style={photoBox}>
              <label style={label}>Foto do usuário</label>

              <div style={avatarPreview}>
                {form.foto_url ? (
                  <img src={form.foto_url} alt="Foto" style={avatarImg} />
                ) : (
                  <span style={{ fontSize: 34 }}>📷</span>
                )}
              </div>

              <label style={uploadBtn}>
                Selecionar foto
                <input
                  type="file"
                  accept="image/*"
                  onChange={selecionarFoto}
                  style={{ display: "none" }}
                />
              </label>

              <small style={{ color: "#c4b5fd" }}>JPG, PNG ou GIF até 2MB</small>
            </div>

            <div>
              <label style={label}>Nome completo</label>
              <input
                style={input}
                value={form.nome}
                onChange={(e) => atualizar("nome", e.target.value)}
                placeholder="Digite o nome completo"
              />
            </div>

            <div>
              <label style={label}>E-mail corporativo</label>
              <input
                style={input}
                value={form.email}
                onChange={(e) => atualizar("email", e.target.value)}
                placeholder="exemplo@aelbra.com.br"
              />
            </div>

            <div>
              <label style={label}>Perfil</label>
              <select
                style={input}
                value={form.perfil}
                onChange={(e) => atualizar("perfil", e.target.value)}
              >
                {perfis.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={label}>Operador</label>
              <input
                style={input}
                value={form.operador}
                onChange={(e) => atualizar("operador", e.target.value)}
                placeholder="Ex: OLGA"
              />
            </div>
          </div>

          <div style={actions}>
            <label style={toggleLabel}>
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => atualizar("ativo", e.target.checked)}
              />
              Usuário ativo
            </label>

            <label style={toggleLabel}>
              <input
                type="checkbox"
                checked={form.receptivo}
                onChange={(e) => atualizar("receptivo", e.target.checked)}
              />
              Operador receptivo (entra na fila de ligação/whatsapp)
            </label>

            <div style={{ display: "flex", gap: 12 }}>
              <button type="button" onClick={limpar} style={btnGhost}>
                Limpar
              </button>

              <button type="submit" disabled={carregando} style={btnGreen}>
                {carregando ? "Salvando..." : "Salvar usuário"}
              </button>
            </div>
          </div>

          {erro && <p style={erroStyle}>{erro}</p>}
          {mensagem && <p style={okStyle}>{mensagem}</p>}
        </form>
      </section>

      <div style={filters}>
        <input
          style={searchInput}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, e-mail ou operador..."
        />

        <select
          style={filterSelect}
          value={filtroPerfil}
          onChange={(e) => setFiltroPerfil(e.target.value)}
        >
          <option value="todos">Todos os perfis</option>
          {perfis.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select
          style={filterSelect}
          value={filtroStatus}
          onChange={(e) => setFiltroStatus(e.target.value)}
        >
          <option value="todos">Todos os status</option>
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
        </select>
      </div>

      <section style={tablePanel}>
        <h2 style={sectionTitle}>Usuários cadastrados</h2>

        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Usuário</th>
                <th style={th}>E-mail</th>
                <th style={th}>Perfil</th>
                <th style={th}>Operador</th>
                <th style={th}>Status</th>
                <th style={th}>Receptivo</th>
                <th style={th}>Ações</th>
              </tr>
            </thead>

            <tbody>
              {usuariosFiltrados.map((u) => (
                <tr key={u.email} style={tr}>
                  <td style={td}>
                    <div style={userCell}>
                      <div style={smallAvatar}>
                        {u.foto_url ? (
                          <img src={u.foto_url} alt={u.nome} style={avatarImg} />
                        ) : (
                          (u.nome || "?").charAt(0)
                        )}
                      </div>
                      <div>
                        <strong>{u.nome}</strong>
                        <div style={{ color: "#a78bfa", fontSize: 12 }}>
                          {u.operador_nome}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td style={td}>{u.email}</td>
                  <td style={td}>
                    <span style={badge}>{u.perfil}</span>
                  </td>
                  <td style={td}>{u.operador}</td>
                  <td style={td}>
                    <span style={u.ativo ? activeBadge : inactiveBadge}>
                      {u.ativo ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td style={td}>
                    <span style={u.receptivo ? activeBadge : inactiveBadge}>
                      {u.receptivo ? "Receptivo" : "-"}
                    </span>
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={miniBtn} onClick={() => editarUsuario(u)}>
                        Editar
                      </button>
                      <button style={miniBtn} onClick={() => alternarAtivo(u)}>
                        {u.ativo ? "Inativar" : "Ativar"}
                      </button>
                      <button style={miniBtn} onClick={() => alternarReceptivo(u)}>
                        {u.receptivo ? "Tirar receptivo" : "Marcar receptivo"}
                      </button>
                      <button
                        style={dangerBtn}
                        onClick={() => removerUsuario(u)}
                      >
                        Remover
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {usuariosFiltrados.length === 0 && (
                <tr>
                  <td style={td} colSpan="7">
                    Nenhum usuário encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div style={card}>
      <div style={cardValue}>{value}</div>
      <div style={cardLabel}>{label}</div>
    </div>
  );
}

const page = {
  padding: 24,
  background: "#0b1220",
  color: "#fff",
  minHeight: "100%",
};

const title = {
  color: "#c084fc",
  margin: 0,
  fontSize: 34,
};

const subtitle = {
  color: "#ddd6fe",
  marginTop: 8,
};

const cards = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: 16,
  marginTop: 22,
  marginBottom: 22,
};

const card = {
  background: "#111827",
  border: "1px solid #312e81",
  borderRadius: 16,
  padding: 20,
};

const cardValue = {
  fontSize: 28,
  fontWeight: 900,
};

const cardLabel = {
  color: "#c4b5fd",
  marginTop: 6,
};

const panel = {
  background: "linear-gradient(135deg,#1e0038,#101827)",
  border: "1px solid #7e22ce",
  borderRadius: 18,
  padding: 22,
  marginBottom: 24,
};

const tablePanel = {
  background: "#111827",
  border: "1px solid #334155",
  borderRadius: 18,
  padding: 20,
};

const sectionTitle = {
  marginTop: 0,
  marginBottom: 18,
};

const formGrid = {
  display: "grid",
  gridTemplateColumns: "220px repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
  alignItems: "end",
};

const photoBox = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "center",
  borderRight: "1px solid #312e81",
  paddingRight: 16,
};

const avatarPreview = {
  width: 96,
  height: 96,
  borderRadius: "50%",
  border: "2px dashed #9333ea",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  background: "#0f172a",
};

const avatarImg = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

const smallAvatar = {
  width: 42,
  height: 42,
  borderRadius: "50%",
  background: "#581c87",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  fontWeight: 900,
};

const uploadBtn = {
  background: "#7e22ce",
  padding: "8px 12px",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 800,
};

const label = {
  display: "block",
  marginBottom: 6,
  color: "#ddd6fe",
  fontWeight: 800,
};

const input = {
  width: "100%",
  padding: 12,
  borderRadius: 10,
  border: "1px solid #7e22ce",
  background: "#0f172a",
  color: "#fff",
  fontWeight: 700,
};

const actions = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginTop: 18,
  gap: 12,
};

const toggleLabel = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  color: "#ddd6fe",
  fontWeight: 800,
};

const btnGreen = {
  background: "#22c55e",
  color: "#020617",
  border: "none",
  borderRadius: 12,
  padding: "12px 18px",
  fontWeight: 900,
  cursor: "pointer",
};

const btnGhost = {
  background: "#1f2937",
  color: "#fff",
  border: "1px solid #475569",
  borderRadius: 12,
  padding: "12px 18px",
  fontWeight: 900,
  cursor: "pointer",
};

const filters = {
  display: "flex",
  gap: 12,
  marginBottom: 16,
  flexWrap: "wrap",
};

const searchInput = {
  ...input,
  maxWidth: 420,
};

const filterSelect = {
  ...input,
  maxWidth: 220,
};

const table = {
  width: "100%",
  borderCollapse: "collapse",
};

const th = {
  background: "#3b0764",
  padding: 12,
  textAlign: "left",
};

const tr = {
  borderBottom: "1px solid #334155",
};

const td = {
  padding: 12,
  verticalAlign: "middle",
};

const userCell = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const badge = {
  border: "1px solid #7e22ce",
  color: "#c084fc",
  padding: "5px 10px",
  borderRadius: 999,
  fontWeight: 800,
};

const activeBadge = {
  background: "#052e16",
  color: "#22c55e",
  padding: "5px 10px",
  borderRadius: 999,
  fontWeight: 800,
};

const inactiveBadge = {
  background: "#450a0a",
  color: "#f87171",
  padding: "5px 10px",
  borderRadius: 999,
  fontWeight: 800,
};

const miniBtn = {
  background: "#312e81",
  color: "#fff",
  border: "1px solid #6366f1",
  borderRadius: 8,
  padding: "7px 10px",
  fontWeight: 800,
  cursor: "pointer",
};

const dangerBtn = {
  background: "#450a0a",
  color: "#f87171",
  border: "1px solid #ef4444",
  borderRadius: 8,
  padding: "7px 10px",
  fontWeight: 800,
  cursor: "pointer",
};

const erroStyle = {
  color: "#f87171",
  fontWeight: 900,
};

const okStyle = {
  color: "#22c55e",
  fontWeight: 900,
};