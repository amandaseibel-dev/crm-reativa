// @vitest-environment jsdom
//
// Abertura de anexo na Central.
//
// POR QUE ESTE ARQUIVO EXISTE: em 20/08/2026 o PDF chegou inteiro no bucket e
// mesmo assim o operador não conseguiu abrir. A URL assinada era gerada na
// MONTAGEM do componente e congelava no `href`; ela vale 300s, então cinco
// minutos com a conversa aberta bastavam para o clique levar a uma pagina de
// JSON crua do Supabase (`400 InvalidJWT`). Recarregar "consertava" por mais
// cinco minutos — por isso parecia intermitente.
//
// O teste que importa aqui nao e "renderiza": e "o operador clica e abre".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import AnexoWhatsApp from "./AnexoWhatsApp";

const storage = vi.hoisted(() => ({
  chamadas: [],
  resposta: null,
  demora: 0,
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (caminho, seg) => {
          storage.chamadas.push({ bucket, caminho, seg });
          if (storage.demora) await new Promise((r) => setTimeout(r, storage.demora));
          return storage.resposta;
        },
      }),
    },
  },
}));

const PDF = {
  midia_path: "2026/08/0f12c1b6.pdf",
  midia_mime: "application/pdf",
  midia_nome: "ATA_assinado.pdf",
  midia_tamanho: 243881,
};
const IMAGEM = {
  midia_path: "2026/08/99f4c563.jpeg",
  midia_mime: "image/jpeg",
  midia_tamanho: 74916,
};

let abertas;

beforeEach(() => {
  storage.chamadas = [];
  storage.demora = 0;
  storage.resposta = { data: { signedUrl: "https://x.supabase.co/assinada?token=novo" }, error: null };
  abertas = [];
  vi.stubGlobal("open", vi.fn(() => {
    const aba = { location: { replace: vi.fn() }, close: vi.fn(), opener: {} };
    abertas.push(aba);
    return aba;
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("documento — assina no clique, nunca antes", () => {
  it("NAO chama o Storage so por renderizar a conversa", async () => {
    render(<AnexoWhatsApp mensagem={PDF} />);
    await waitFor(() => expect(screen.getByText(/ATA_assinado\.pdf/)).toBeTruthy());
    // Este era o defeito: assinar na montagem e deixar o href apodrecer.
    expect(storage.chamadas).toHaveLength(0);
  });

  it("clicar depois de muito tempo funciona: a URL nasce AGORA", async () => {
    render(<AnexoWhatsApp mensagem={PDF} />);
    const link = await screen.findByText(/ATA_assinado\.pdf/);

    fireEvent.click(link);

    await waitFor(() => expect(storage.chamadas).toHaveLength(1));
    expect(storage.chamadas[0].caminho).toBe(PDF.midia_path);
    // Validade curta preservada.
    expect(storage.chamadas[0].seg).toBe(300);
    await waitFor(() =>
      expect(abertas[0].location.replace).toHaveBeenCalledWith("https://x.supabase.co/assinada?token=novo"));
  });

  it("a aba nasce ANTES do await — e o que escapa do bloqueador de popup", async () => {
    storage.demora = 30; // assinatura lenta
    render(<AnexoWhatsApp mensagem={PDF} />);
    fireEvent.click(await screen.findByText(/ATA_assinado\.pdf/));

    // Imediatamente, ainda sem resposta do Storage, a aba ja existe.
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(abertas).toHaveLength(1);
    expect(abertas[0].location.replace).not.toHaveBeenCalled();

    await waitFor(() => expect(abertas[0].location.replace).toHaveBeenCalled());
  });

  it("corta o vinculo com a aba (opener = null) sem perder a referencia", async () => {
    render(<AnexoWhatsApp mensagem={PDF} />);
    fireEvent.click(await screen.findByText(/ATA_assinado\.pdf/));
    await waitFor(() => expect(abertas[0].location.replace).toHaveBeenCalled());
    expect(abertas[0].opener).toBeNull();
  });

  it("clique duplo nao abre duas abas", async () => {
    storage.demora = 40;
    render(<AnexoWhatsApp mensagem={PDF} />);
    const link = await screen.findByText(/ATA_assinado\.pdf/);

    fireEvent.click(link);
    fireEvent.click(link);
    fireEvent.click(link);

    await waitFor(() => expect(abertas[0].location.replace).toHaveBeenCalled());
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(storage.chamadas).toHaveLength(1);
  });

  it("falha na assinatura: fecha a aba vazia e explica ao operador", async () => {
    storage.resposta = { data: null, error: { message: "expired" } };
    render(<AnexoWhatsApp mensagem={PDF} />);
    fireEvent.click(await screen.findByText(/ATA_assinado\.pdf/));

    await waitFor(() => expect(abertas[0].close).toHaveBeenCalled());
    // Mensagem compreensivel, nao um JSON do Supabase.
    const aviso = await screen.findByText(/não foi possível abrir o anexo agora/i);
    expect(aviso).toBeTruthy();
    expect(abertas[0].location.replace).not.toHaveBeenCalled();
  });

  it("popup bloqueado (window.open devolve null): avisa como liberar", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    render(<AnexoWhatsApp mensagem={PDF} />);
    fireEvent.click(await screen.findByText(/ATA_assinado\.pdf/));

    expect(await screen.findByText(/bloqueou a nova aba/i)).toBeTruthy();
  });

  it("depois de um erro, um novo clique tenta de novo", async () => {
    storage.resposta = { data: null, error: { message: "falhou" } };
    render(<AnexoWhatsApp mensagem={PDF} />);
    const link = await screen.findByText(/ATA_assinado\.pdf/);
    fireEvent.click(link);
    await screen.findByText(/não foi possível abrir o anexo agora/i);

    storage.resposta = { data: { signedUrl: "https://x/ok" }, error: null };
    fireEvent.click(link);
    await waitFor(() => expect(abertas[1].location.replace).toHaveBeenCalledWith("https://x/ok"));
  });
});

describe("imagem — aparece sozinha, mas o clique assina de novo", () => {
  it("assina na montagem PORQUE precisa aparecer", async () => {
    render(<AnexoWhatsApp mensagem={IMAGEM} />);
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("https://x.supabase.co/assinada?token=novo");
    expect(storage.chamadas).toHaveLength(1);
  });

  it("clicar para ampliar gera URL NOVA, nao reusa a da montagem", async () => {
    render(<AnexoWhatsApp mensagem={IMAGEM} />);
    const img = await screen.findByRole("img");
    storage.resposta = { data: { signedUrl: "https://x/segunda" }, error: null };

    fireEvent.click(img);

    await waitFor(() => expect(storage.chamadas).toHaveLength(2));
    await waitFor(() => expect(abertas[0].location.replace).toHaveBeenCalledWith("https://x/segunda"));
  });
});

describe("estados que nao podem sumir", () => {
  it("anexo nao recuperado continua avisando o operador", () => {
    render(<AnexoWhatsApp mensagem={{ midia_erro: "arquivo expirou no WhatsApp" }} />);
    expect(screen.getByText(/Anexo não recuperado/)).toBeTruthy();
    expect(screen.getByText(/arquivo expirou no WhatsApp/)).toBeTruthy();
  });

  it("mensagem sem anexo nao renderiza nada e nao chama o Storage", () => {
    const { container } = render(<AnexoWhatsApp mensagem={{ texto: "oi" }} />);
    expect(container.innerHTML).toBe("");
    expect(storage.chamadas).toHaveLength(0);
  });

  it("nenhuma signed URL e persistida — so vive no estado do componente", async () => {
    render(<AnexoWhatsApp mensagem={PDF} />);
    fireEvent.click(await screen.findByText(/ATA_assinado\.pdf/));
    await waitFor(() => expect(abertas[0].location.replace).toHaveBeenCalled());
    const guardado = JSON.stringify(localStorage) + JSON.stringify(sessionStorage);
    expect(guardado).not.toContain("assinada");
    expect(guardado).not.toContain("token=novo");
  });
});
