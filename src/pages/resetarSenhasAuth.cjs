require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("ERRO: confira se o .env tem SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const SENHA_PADRAO = "Reativa@2026";

const usuarios = [
  {
    nome: "Amanda",
    email: "amanda.seibel@aelbra.com.br",
    perfil: "gerencia",
    operador_nome: "Amanda",
    operador: "AMANDA",
  },
  {
    nome: "Fernanda",
    email: "cobranca04@aelbra.com.br",
    perfil: "supervisor",
    operador_nome: "Fernanda",
    operador: "FERNANDA",
  },
  {
    nome: "Luana",
    email: "cobranca05@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Luana",
    operador: "LUANA",
  },
  {
    nome: "Rafaella",
    email: "cobranca12@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Rafaella",
    operador: "RAFAELLA",
  },
  {
    nome: "Amanda Borges",
    email: "cobranca07@aelbra.com.br",
    perfil: "administrativo",
    operador_nome: "Amanda Borges",
    operador: "AMANDA BORGES",
  },
  {
    nome: "Allan",
    email: "cobranca11@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Allan",
    operador: "ALLAN",
  },
  {
    nome: "Mauricio",
    email: "cobranca06@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Mauricio",
    operador: "MAURICIO",
  },
  {
    nome: "Olga",
    email: "cobranca03@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Olga",
    operador: "OLGA",
  },
  {
    nome: "João",
    email: "cobranca10@aelbra.com.br",
    perfil: "operador",
    operador_nome: "João",
    operador: "JOAO",
  },
  {
    nome: "Diego",
    email: "cobranca13@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Diego",
    operador: "DIEGO",
  },
  {
    nome: "Natali",
    email: "cobranca08@aelbra.com.br",
    perfil: "operador",
    operador_nome: "Natali",
    operador: "NATALI",
  },
];

async function buscarUsuarioAuthPorEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return data.users.find(
    (user) => user.email?.toLowerCase() === email.toLowerCase()
  );
}

async function atualizarTabelaUsuarios(authUserId, usuario) {
  const { data: existente, error: erroBusca } = await supabase
    .from("usuarios")
    .select("id,email")
    .eq("email", usuario.email)
    .maybeSingle();

  if (erroBusca) {
    throw erroBusca;
  }

  if (existente) {
    const { error } = await supabase
      .from("usuarios")
      .update({
        nome: usuario.nome,
        perfil: usuario.perfil,
        ativo: true,
        operador_nome: usuario.operador_nome,
        operador: usuario.operador,
      })
      .eq("email", usuario.email);

    if (error) throw error;
  } else {
    const { error } = await supabase.from("usuarios").insert({
      id: authUserId,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      ativo: true,
      operador_nome: usuario.operador_nome,
      operador: usuario.operador,
    });

    if (error) throw error;
  }
}

async function executar() {
  console.log("RESETANDO SENHAS NO AUTH...\n");

  for (const usuario of usuarios) {
    const email = usuario.email.toLowerCase();

    try {
      let authUser = await buscarUsuarioAuthPorEmail(email);

      if (authUser) {
        const { data, error } = await supabase.auth.admin.updateUserById(
          authUser.id,
          {
            password: SENHA_PADRAO,
            email_confirm: true,
            user_metadata: {
              nome: usuario.nome,
              perfil: usuario.perfil,
            },
          }
        );

        if (error) throw error;

        authUser = data.user;
        console.log(`SENHA RESETADA: ${email}`);
      } else {
        const { data, error } = await supabase.auth.admin.createUser({
          email,
          password: SENHA_PADRAO,
          email_confirm: true,
          user_metadata: {
            nome: usuario.nome,
            perfil: usuario.perfil,
          },
        });

        if (error) throw error;

        authUser = data.user;
        console.log(`CRIADO NO AUTH: ${email}`);
      }

      await atualizarTabelaUsuarios(authUser.id, usuario);
      console.log(`PERFIL OK: ${usuario.nome} | ${usuario.perfil}\n`);
    } catch (error) {
      console.error(`ERRO EM ${email}:`, error.message || error);
      console.log("");
    }
  }

  console.log("FINALIZADO.");
  console.log("Senha padrão para todos:", SENHA_PADRAO);
}

executar();