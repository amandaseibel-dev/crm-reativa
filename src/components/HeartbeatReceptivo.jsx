import { useEffect } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

// Mantém o operador "online" na fila do receptivo enquanto ele estiver
// logado no sistema, em qualquer tela -- antes o heartbeat só rodava
// dentro do widget da Fila Operacional, então quem saía pra atender um
// aluno em outra tela (Aluno, CRM, etc.) caía como "offline" em 90s e
// sumia da fila, mesmo trabalhando normalmente. Este componente não
// renderiza nada, só mantém o heartbeat vivo em segundo plano.
export default function HeartbeatReceptivo({ usuario }) {
  const email = usuario?.perfil?.email || usuario?.auth?.email || "";
  const ehReceptivo = Boolean(usuario?.perfil?.receptivo);

  useEffect(() => {
    if (!ehReceptivo || !email) return;

    let cancelado = false;
    let batendo = false;

    async function bater() {
      if (batendo) return; // sem sobreposicao
      batendo = true;
      try {
        const { data: sess } = await supabase.auth.getSession();
        if (!sess?.session) { batendo = false; return; } // so autenticado
        // Refresh proativo: se a aba ficou muito tempo parada/em segundo
        // plano, o token pode ter expirado e o RPC falharia silenciosamente,
        // parando de atualizar online_em sem nunca lançar erro visível.
        await supabase.rpc("fila_receptivo_heartbeat", {
          p_email: email,
          p_nome: nomeOperadorPorEmail(email),
        });
      } catch (e) {
        if (!cancelado) console.warn("Erro no heartbeat do receptivo:", e);
      } finally {
        batendo = false;
      }
    }

    bater();
    // A fila considera o operador offline em 90s (LIMITE_ONLINE_MS). Com 40s
    // ele bate 2x antes de expirar -- margem segura para nao perder a posicao
    // mesmo se uma batida falhar -- pela metade das chamadas de antes.
    // EXCECAO PROPOSITAL a regra de pausar em aba oculta: o operador costuma
    // ficar com o CRM em segundo plano enquanto atende no WhatsApp. Pausar
    // aqui o derrubaria da fila do receptivo. Este é o unico polling que
    // continua rodando com a aba oculta.
    const intervalo = setInterval(bater, 40000);

    // Se o navegador atrasou o setInterval (aba em segundo plano) e o
    // operador volta pra aba, bate na hora em vez de esperar o próximo
    // tick atrasado.
    function aoVoltarFoco() {
      if (document.visibilityState === "visible") bater();
    }
    document.addEventListener("visibilitychange", aoVoltarFoco);
    window.addEventListener("focus", aoVoltarFoco);

    return () => {
      cancelado = true;
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", aoVoltarFoco);
      window.removeEventListener("focus", aoVoltarFoco);
    };
  }, [ehReceptivo, email]);

  return null;
}
