require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SENHA_PADRAO = "Reativa@2026";

const usuarios = [
  { nome: "Amanda", email: "amanda.seibel@aelbra.com.br", perfil: "admin", operador: "AMANDA" },
  { nome: "Fernanda", email: "cobranca04@aelbra.com.br", perfil: "supervisor", operador: "FERNANDA" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br", perfil: "operador", operador: "LUANA" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br", perfil: "operador", operador: "RAFAELLA" },
  { nome: "Amanda Borges", email: "cobranca07@aelbra.com.br", perfil: "admin", operador: "AMANDA BORGES" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br", perfil: "operador", operador: "ALLAN" },
  { nome: "Mauricio", email: "cobranca06@aelbra.com.br", perfil: "operador", operador: "MAURICIO" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br", perfil: "operador", operador: "OLGA" },
  { nome: "João", email: "cobranca10@aelbra.com.br", perfil: "operador", operador: "JOAO" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br", perfil: "operador", operador: "DIEGO" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br", perfil: "operador", operador: "NATALI" },
];

async function criarOuAtualizarUsuario(u) {
  const email = u.email.toLowerCase().trim();

  let userId = null;

  const { data: criado, error: erroCriar } =
    await supabase.auth.admin.createUser({
      email,
      password: SENHA_PADRAO,
      email_confirm: true,
      user_metadata: {
        nome: u.nome,
        perfil: u.perfil,
        operador: u.operador,
      },
    });

  if (erroCriar) {
    const { data: lista, error: erroLista } =
      await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });

    if (erroLista) throw erroLista;

    const existente = lista.users.find(
      (user) => user.email?.toLowerCase() === email
    );

    if (!existente) throw erroCriar;

    userId = existente.id;

    await supabase.auth.admin.updateUserById(userId, {
      password: SENHA_PADRAO,
      email_confirm: true,
      user_metadata: {
        nome: u.nome,
        perfil: u.perfil,
        operador: u.operador,
      },
    });
  } else {
    userId = criado.user.id;
  }

  const { error: erroPerfil } = await supabase.from("usuarios").upsert(
    {
      id: userId,
      nome: u.nome,
      email,
      perfil: u.perfil,
      ativo: true,
      operador_nome: u.nome,
      operador: u.operador,
    },
    { onConflict: "email" }
  );

  if (erroPerfil) throw erroPerfil;

  console.log(`OK: ${u.nome} - ${email}`);
}

async function executar() {
  console.log("Criando usuários...");
  for (const usuario of usuarios) {
    await criarOuAtualizarUsuario(usuario);
  }

  console.log("");
  console.log("FINALIZADO.");
  console.log(`Senha padrão: ${SENHA_PADRAO}`);
}

executar().catch((erro) => {
  console.error("ERRO:", erro.message || erro);
  process.exit(1);
});