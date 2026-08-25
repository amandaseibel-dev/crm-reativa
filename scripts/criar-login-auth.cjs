/**
 * Garante que quem JÁ tem cadastro ativo em `usuarios` consiga entrar.
 *
 * Existe porque a tela /usuarios grava só a tabela `usuarios` — ela nunca cria
 * a conta de login. E o botão "enviar redefinição de senha" depende do SMTP
 * padrão do Supabase, que só entrega para membros da organização: para os
 * demais a API responde "enviado" e a mensagem não sai. Foi assim que a Angela
 * ficou cadastrada, com login criado, e sem nunca receber nada.
 *
 * Dois modos, decididos pelo estado do Auth:
 *   - sem login  -> cria a conta com a senha provisória
 *   - com login  -> troca a senha para a provisória (só de quem nunca entrou)
 *
 * Em ambos, `deve_trocar_senha` fica armado: a pessoa é obrigada a definir a
 * senha dela na primeira entrada, então a provisória morre no primeiro uso.
 *
 * A senha provisória é entregue por fora (WhatsApp, presencial) — nunca por
 * e-mail, que é justamente o canal quebrado.
 *
 *   node scripts/criar-login-auth.cjs angela.ferreira@aelbra.com.br
 *
 * Para trocar a senha de quem JÁ entrou alguma vez, é preciso ser explícito:
 *
 *   node scripts/criar-login-auth.cjs fulano@aelbra.com.br --trocar-senha-de-quem-ja-entrou
 *
 * A chave e a senha sao perguntadas na hora, com digitacao oculta: nao ficam
 * no historico do shell nem em arquivo nenhum.
 */
const { createClient } = require("@supabase/supabase-js");
const readline = require("readline");

const PROJETO_PROD = "ahattpqrjmhkzsmnbdzs";
const URL = `https://${PROJETO_PROD}.supabase.co`;

const argumentos = process.argv.slice(2);
const email = (argumentos.find((a) => !a.startsWith("--")) || "").trim().toLowerCase();
// Trocar a senha de quem já usa o sistema derruba a sessão dela sem aviso.
// Só acontece se quem roda pedir por escrito.
const trocarDeQuemJaEntrou = argumentos.includes("--trocar-senha-de-quem-ja-entrou");

if (!email) {
  console.error("Uso: node scripts/criar-login-auth.cjs <email> [--trocar-senha-de-quem-ja-entrou]");
  process.exit(1);
}

// Pergunta sem ecoar: o terminal nao mostra, o historico nao guarda.
function perguntarOculto(rotulo) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const escrever = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (texto) => {
      if (texto.includes(rotulo)) escrever(texto);
    };
    rl.question(rotulo, (resposta) => {
      rl.close();
      process.stdout.write("\n");
      resolve(resposta.trim());
    });
  });
}

async function executar() {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || (await perguntarOculto("Service role key (producao): "));
  const senha = process.env.SENHA_PROVISORIA || (await perguntarOculto("Senha provisoria: "));

  if (!chave || !senha) {
    console.error("ABORTADO: chave e senha sao obrigatorias.");
    process.exit(1);
  }

  const supabase = createClient(URL, chave, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Projeto: ${PROJETO_PROD} (PRODUÇÃO)\nE-mail:  ${email}\n`);

  // 1. Só cria login para quem a gestão já cadastrou e deixou ativo.
  const { data: cadastro, error: erroCadastro } = await supabase
    .from("usuarios")
    .select("nome, perfil, ativo, deve_trocar_senha")
    .eq("email", email)
    .maybeSingle();

  if (erroCadastro) throw erroCadastro;
  if (!cadastro) {
    console.error("ABORTADO: não existe cadastro em `usuarios` para esse e-mail.");
    console.error("Cadastre primeiro em /usuarios — o login sozinho não dá acesso a nada.");
    process.exit(1);
  }
  if (!cadastro.ativo) {
    console.error("ABORTADO: o cadastro existe mas está INATIVO. Reative em /usuarios antes.");
    process.exit(1);
  }
  console.log(`Cadastro encontrado: ${cadastro.nome} — perfil ${cadastro.perfil}\n`);

  // 2. Não sobrescreve senha de quem já entra: só cria o que falta.
  const { data: lista, error: erroLista } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (erroLista) throw erroLista;

  const jaExiste = lista.users.find((u) => u.email?.toLowerCase() === email);

  let usuarioAuth;
  if (jaExiste) {
    // Login existe e a pessoa nunca entrou = ela nunca soube a senha, porque o
    // e-mail de redefinição não sai pelo SMTP padrão. Dar uma provisória é o
    // único caminho — não há sessão nem senha em uso para atropelar.
    const nuncaEntrou = !jaExiste.last_sign_in_at;
    if (!nuncaEntrou && !trocarDeQuemJaEntrou) {
      console.error(`ABORTADO: já existe login no Auth (id ${jaExiste.id}) e essa pessoa JÁ entrou`);
      console.error(`(último acesso: ${jaExiste.last_sign_in_at}).`);
      console.error("Trocar a senha agora derruba a sessão dela. Se é isso mesmo que você quer,");
      console.error("rode de novo com --trocar-senha-de-quem-ja-entrou.");
      process.exit(1);
    }

    console.log(
      nuncaEntrou
        ? `Login já existe (id ${jaExiste.id}) e nunca foi usado — definindo senha provisória.\n`
        : `Login já existe (id ${jaExiste.id}) e JÁ foi usado — trocando a senha a pedido explícito.\n`
    );

    const { data: atualizado, error: erroSenha } = await supabase.auth.admin.updateUserById(jaExiste.id, {
      password: senha,
      email_confirm: true, // sem isso ela fica travada esperando e-mail de confirmação
    });
    if (erroSenha) throw erroSenha;
    usuarioAuth = atualizado.user;
    console.log(`SENHA PROVISÓRIA DEFINIDA — id ${usuarioAuth.id}`);
  } else {
    const { data: criado, error: erroCriar } = await supabase.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true, // sem isso ela fica travada esperando e-mail de confirmação
    });
    if (erroCriar) throw erroCriar;
    usuarioAuth = criado.user;
    console.log(`LOGIN CRIADO — id ${usuarioAuth.id}`);
  }

  // A provisória só é segura porque morre no primeiro uso. Se a trava estiver
  // desarmada, armar é parte do trabalho — não um aviso para alguém lembrar.
  if (!cadastro.deve_trocar_senha) {
    const { error: erroTrava } = await supabase
      .from("usuarios")
      .update({ deve_trocar_senha: true })
      .eq("email", email);
    if (erroTrava) throw erroTrava;
    console.log("deve_trocar_senha estava false — ARMADO agora.");
  }
  console.log("Troca de senha na primeira entrada: ARMADA (deve_trocar_senha=true).");
  console.log("Entregue a senha provisória por WhatsApp ou pessoalmente — por e-mail não chega.");
}

executar().catch((e) => {
  console.error("FALHOU:", e.message || e);
  process.exit(1);
});
