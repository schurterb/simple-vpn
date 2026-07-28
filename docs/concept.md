A simple VPN solution for playing Vintage Story on a self-hosted server.
Each node will be running on a personal PC - some of which may be on the same network and one of which will host the Vintage Story server.
The VPN MUST not disrupt normal internet connectivity for users.  
It MUST make connecting to the server as simple and easy as if they were all playing on the same local network in the same house.
It MUST be able to handle multiple nodes connecting from the same network.
It MUST be able to handle nodes connecting from different networks.
It SHOULD not require a central relay server.
It MAY require manual configuration of the VPN on each node.
Any manual configuration MUST be as intuitive as possible.
It SHOULD provide a convenient, clean UI - ideally a locally running web interface.
It MUST maximally fast and reasonably secure.
If existing solutions can meet these requirements, they should be used.
If new code must be written, use Golang for the backend and JavaScript + HTML for the frontend.