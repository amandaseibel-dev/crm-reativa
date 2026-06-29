require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const SENHA = "Reativa@2026";

const usuarios = [
  ["Amanda", "amanda.seibel@aelbra.com.br", "gerencia", "AMANDA"],
  ["Fernanda", "cobranca04@aelbra.com.br", "supervisor", "FERNANDA"],
  ["Luana", "cobranca05@aelbra.com.br", "operador", "LUANA"],
  ["Rafaella", "cobranca12@aelbra.com.br", "operador", "RAFAELLA"],
  ["Amanda Borges", "cobranca07@aelbra.com.br", "administrativo", "AMANDA BORGES"],
  ["Allan", "cobranca11@aelbra.com.br", "operador", "ALLAN"],
  ["Mauricio", "cobranca06@aelbra.com.br", "operador", "MAURICIO"],
  ["Olga", "cobranca03@aelbra.com.br", "operador", "OLGA"],
  ["João", "cobranca10@aelbra.com.br", "operador", "JOAO"],
  ["Diego", "cobranca13@aelbra.com.br", "operador", "DIEGO"],
  ["Natali", "cobranca08@aelbra.com.br", "operador", "NATALI"],
];

async function buscarAuth(email) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return data.users.find(
    (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
  );
}

async function executar() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("ERRO: falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no arquivo .env");
    return;
  }

  console.log("Resetando senhas...\n");

  for (const [nome, email, perfil, operador] of usuarios) {
    try {
      const user = await buscarAuth(email);

      if (!user) {
        console.log("NÃO ENCONTRADO NO AUTH:", email);
        continue;
      }

      const { error: erroSenha } = await supabase.auth.admin.updateUserById(
        user.id,
        {
          password: SENHA,
          email_confirm: true,
          user_metadata: { nome, perfil },
        }
      );

      if (erroSenha) throw erroSenha;

      const { error: erroTabela } = await supabase
        .from("usuarios")
        .update({
          nome,
          perfil,
          ativo: true,
          operador_nome: nome,
          operador,
        })
        .eq("email", email);

      if (erroTabela) throw erroTabela;

      console.log("OK:", nome, "-", email);
    } catch (err) {
      console.log("ERRO:", email, "-", err.message);
    }
  }

  console.log("\nFINALIZADO.");
  console.log("Senha padrão:", SENHA);
}

executar();
